import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { config } from '../config.js';
import type { Incident } from '../types.js';
import { groundEvidence, ollamaAnalyzer, parseAnalysis } from './ai.js';
import { applyProposedChanges, incidentKeywords, quotedCode, quotedCodeScore, rankByContent, referencedBlocks, staticFindings, unifiedDiff, validateChanges } from './patch.js';
import { assertSafeBranch, checkPath, GitHubRepo, GitLabRepo } from './repo.js';
import { teamsPayload } from './teams.js';

const validJson = {
  summary: 's',
  probableRootCause: 'r',
  evidence: [{ type: 'fact', statement: 'x', quote: 'boom' }],
  confidence: 0.8,
  recommendedFix: 'f',
  preventiveActions: [],
  proposedChanges: [],
  validationPlan: [],
  limitations: [],
};

test('parseAnalysis validates model output and normalizes confidence', () => {
  const a = parseAnalysis(`<think>hmm</think>\n${JSON.stringify(validJson)}`);
  assert.equal(a.confidence, 80);
  assert.throws(() => parseAnalysis('no json here'), /no JSON object/);
  assert.throws(() => parseAnalysis(JSON.stringify({ ...validJson, evidence: 'nope' })), /failed validation/);
  assert.throws(() => parseAnalysis(JSON.stringify({ ...validJson, confidence: 400 })), /failed validation/);
});

test('groundEvidence demotes facts whose quote is not in the input', () => {
  const incident = { title: 't', description: 'it went boom', logs: '' } as Incident;
  const a = parseAnalysis(JSON.stringify({
    ...validJson,
    evidence: [
      { type: 'fact', statement: 'ok', quote: 'went   BOOM' },
      { type: 'fact', statement: 'made up', quote: 'segfault at 0x0' },
      { type: 'fact', statement: 'no quote' },
      { type: 'fact', statement: 'it went boom' },
    ],
  }));
  const g = groundEvidence(a, { incident, files: [] });
  assert.deepEqual(g.evidence.map((e) => e.type), ['fact', 'hypothesis', 'hypothesis', 'fact']);
  assert.equal(g.evidence[3].quote, 'it went boom');
  assert.equal(g.evidence[3].statement, 'Verbatim from the provided data');
  assert.match(g.limitations.at(-2)!, /2 model-claimed fact/);
  assert.equal(g.confidence, 50, 'report-only evidence caps confidence');
  assert.match(g.limitations.at(-1)!, /No repository files were available/);
});

test('groundEvidence keeps confidence when a fact is quoted from the repository code', () => {
  const incident = { title: 'run.sh: line 14: PORT: unbound variable', description: '', logs: '' } as Incident;
  const a = parseAnalysis(JSON.stringify({
    ...validJson,
    confidence: 95,
    evidence: [{ type: 'fact', statement: 'PORT default is commented out', quote: '#PORT=7000' }],
  }));
  const g = groundEvidence(a, { incident, files: [{ path: 'run.sh', content: 'set -euo pipefail\n#PORT=7000\n' }] });
  assert.equal(g.evidence[0].source, 'repository');
  assert.equal(g.confidence, 95);
});

test('quotedCode extracts code lines and identifiers from a report, not log prose', () => {
  const nat = quotedCode({
    title: '#enable_nat_gateway = true',
    description: 'do uncomment this',
    logs: '#enable_nat_gateway = true\ndo uncomment this  do uncomment this as this cause network error',
  } as Incident);
  assert.deepEqual(nat.lines, ['#enable_nat_gateway = true', 'enable_nat_gateway = true']);
  assert.deepEqual(nat.identifiers, ['enable_nat_gateway']);
  const mainTf = 'module "vpc" {\n  source = "terraform-aws-modules/vpc/aws"\n  #enable_nat_gateway = true\n}\n';
  assert.ok(quotedCodeScore(mainTf, nat) >= 10, 'exact quoted line found');
  assert.equal(quotedCodeScore('kind: Gateway\nspec:\n  servers: []\n', nat), 0);
  const svc = { lines: ['type: Cluster'], identifiers: [] };
  assert.equal(quotedCodeScore('spec:\n  type: ClusterIP\n', svc), 0, 'whole lines only');
  assert.equal(quotedCodeScore('spec:\n    type:   Cluster   # wrong\n', svc), 10, 'indentation, spacing and trailing comment ignored');

  const port = quotedCode({ title: 'PORT: unbound variable', description: '', logs: 'run.sh: line 14: PORT: unbound variable' } as Incident);
  assert.deepEqual(port, { lines: [], identifiers: [] }, 'error messages are not mistaken for code');

  const yaml = quotedCode({ title: 'pods crash', description: 'replicas: 2 is too low; maxConnections too', logs: '' } as Incident);
  assert.deepEqual(yaml.identifiers, ['maxConnections']);
});

test('checkPath enforces allow list and deny list', () => {
  assert.equal(checkPath('services/a.yaml', ['services/']), null);
  assert.equal(checkPath('docs/incidents/INC-1.md', []), null);
  assert.match(checkPath('src/a.ts', [])!, /allowed paths .* are empty/);
  assert.match(checkPath('other/a.ts', ['services/'])!, /outside/);
  assert.match(checkPath('../etc/passwd', ['services/'])!, /repository-relative/);
  assert.match(checkPath('services/../x', ['services/'])!, /repository-relative/);
  assert.match(checkPath('.github/workflows/ci.yml', ['.github/'])!, /deny list/);
  assert.match(checkPath('services/.env', ['services/'])!, /deny list/);
  assert.match(checkPath('services/tls.key', ['services/'])!, /deny list/);
  assert.equal(checkPath('src/deep/a.ts', ['*']), null, '"*" allows the whole repository');
  assert.match(checkPath('.github/workflows/ci.yml', ['*'])!, /deny list/, '"*" never overrides the deny list');
  assert.match(checkPath('terraform.tfstate', ['*'])!, /deny list/);
});

test('applyProposedChanges treats find == replace on a commented-out line as uncommenting it', () => {
  const runSh = 'set -euo pipefail\n\n#PORT=7000\nfor arg in "$@"; do\n  case "$arg" in\n    --port=*) PORT="${arg#--port=}" ;;\n  esac\ndone\n';
  const originals = new Map([['run.sh', runSh]]);
  // The exact edit qwen3:8b proposed for "run.sh: line 14: PORT: unbound variable".
  const { changes, rejected } = applyProposedChanges(
    [{ file: 'run.sh', description: 'Assign a default value to PORT.', find: 'PORT=7000', replace: 'PORT=7000' }],
    originals,
    ['*'],
  );
  assert.deepEqual(rejected, []);
  assert.equal(changes[0].after, runSh.replace('#PORT=7000', 'PORT=7000'));
  assert.match(changes[0].description, /applied as uncommenting/);

  // Not a commented-out line → still a no-op and rejected.
  const noop = applyProposedChanges([{ file: 'run.sh', description: 'x', find: 'set -euo pipefail', replace: 'set -euo pipefail' }], originals, ['*']);
  assert.equal(noop.changes.length, 0);
  assert.match(noop.rejected[0].reason, /identical/);
  // Text after a marker that is not at the start of the line (e.g. an inline comment) is not touched.
  const inline = applyProposedChanges(
    [{ file: 'a.sh', description: 'x', find: 'note', replace: 'note' }],
    new Map([['a.sh', 'echo hi # note\n']]),
    ['*'],
  );
  assert.equal(inline.changes.length, 0);
});

test('applyProposedChanges only applies unique exact edits to files that were read', () => {
  const originals = new Map([['services/a.yaml', 'a: 1\nb: 1\n']]);
  const { changes, rejected } = applyProposedChanges(
    [
      { file: 'services/a.yaml', description: 'ok', find: 'a: 1', replace: 'a: 2' },
      { file: 'services/a.yaml', description: 'ambiguous', find: ': ', replace: ' = ' },
      { file: 'services/unread.yaml', description: 'unread', find: 'x', replace: 'y' },
      { file: 'secrets/prod.yaml', description: 'denied', find: 'x', replace: 'y' },
    ],
    originals,
    ['services/'],
  );
  assert.equal(changes.length, 1);
  assert.equal(changes[0].after, 'a: 2\nb: 1\n');
  assert.deepEqual(rejected.map((r) => r.file), ['services/a.yaml', 'services/unread.yaml', 'secrets/prod.yaml']);
  assert.match(rejected[0].reason, /matched 2 times/);
});

test('validateChanges catches syntax errors and secrets', () => {
  const change = (path: string, before: string, after: string) => ({ path, description: '', before, after, diff: unifiedDiff(path, before, after) });
  const checks = validateChanges(
    [
      change('services/a.yaml', 'a: 1\n', 'a: [1\n'),
      change('services/b.json', '{}', '{"a": 1}'),
      change('services/c.yaml', 'a: 1\n', 'a: 1\npassword: "hunter2hunter2hunter2"\n'),
      change('services/d.sh', 'echo hi\n', 'if then fi\n'),
    ],
    ['services/'],
  );
  const get = (file: string, name: string) => checks.find((c) => c.file === file && c.name === name)!.status;
  assert.equal(get('services/a.yaml', 'syntax'), 'failed');
  assert.equal(get('services/b.json', 'syntax'), 'passed');
  assert.equal(get('services/c.yaml', 'secret-scan'), 'failed');
  assert.equal(get('services/d.sh', 'syntax'), 'failed');
});

test('rankByContent finds files by keyword when no file name matches', () => {
  const incident = { title: 'incrase an replica', description: 'need more replicas for the api', logs: '' } as Incident;
  const ranked = rankByContent(
    [
      { path: 'terraform/aws/modules/app/main.tf', content: 'resource "kubernetes_deployment" "app" {\n  spec { replicas = var.replicas }\n}' },
      { path: 'terraform/aws/modules/dns/main.tf', content: 'resource "aws_route53_record" "x" {}' },
      { path: 'terraform/aws/modules/app/variables.tf', content: 'variable "replicas" { default = 1 }' },
    ],
    incident,
  );
  assert.deepEqual(ranked, ['terraform/aws/modules/app/main.tf', 'terraform/aws/modules/app/variables.tf']);
});

test('Teams payload is a message with an Adaptive Card attachment', () => {
  const incident = { id: 'INC-1', title: 'Disk full', description: 'ENOSPC on /var', severity: 'critical', source: 'web', status: 'open', timeline: [] } as unknown as Incident;
  const p = teamsPayload('incident_received', incident);
  assert.equal(p.type, 'message');
  assert.equal(p.attachments[0].contentType, 'application/vnd.microsoft.card.adaptive');
  const card = p.attachments[0].content;
  assert.equal(card.type, 'AdaptiveCard');
  assert.match(String(card.body[0].text), /New incident: INC-1/);
  assert.ok(card.body[1].facts!.some((f: { title: string; value: string }) => f.title === 'Severity' && f.value === 'critical'));
  assert.match(String(card.body[2].text), /ENOSPC/);
});

test('branches: never the base branch', () => {
  assert.doesNotThrow(() => assertSafeBranch('nagent/inc-abc-1', 'main'));
  assert.throws(() => assertSafeBranch('main', 'main'));
  assert.throws(() => assertSafeBranch('nagent/../main', 'main'));
});

test('GitHubRepo creates a branch, one commit and a PR via the REST API (mocked fetch)', async () => {
  const calls: Array<{ method: string; url: string; body?: any }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init.method!, url: String(url), body });
    const path = String(url).replace('https://api.github.com/repos/o/r', '');
    const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
    if (path.startsWith('/git/ref/heads/main')) return reply({ object: { sha: 'base-sha' } });
    if (path === '/git/commits/base-sha') return reply({ tree: { sha: 'base-tree' } });
    if (path === '/git/trees') return reply({ sha: 'new-tree' }, 201);
    if (path === '/git/commits') return reply({ sha: 'new-commit' }, 201);
    if (path === '/git/refs') return reply({}, 201);
    if (path === '/pulls') return reply({ html_url: 'https://github.com/o/r/pull/7', number: 7 }, 201);
    return reply({ message: 'Not Found' }, 404);
  }) as typeof fetch;

  try {
    const gh = new GitHubRepo('tok', 'o', 'r', 'main', ['services/']);
    const pr = await gh.createPullRequest({
      branch: 'nagent/inc-1-x',
      title: 'fix',
      body: 'b',
      draft: false,
      files: [{ path: 'services/a.yaml', content: 'a: 2\n' }],
    });
    assert.deepEqual(pr, { url: 'https://github.com/o/r/pull/7', number: 7 });
    assert.equal(calls.find((c) => c.url.endsWith('/git/commits'))!.body.parents[0], 'base-sha');
    assert.equal(calls.find((c) => c.url.endsWith('/git/refs'))!.body.ref, 'refs/heads/nagent/inc-1-x');
    assert.deepEqual(
      { head: calls.at(-1)!.body.head, base: calls.at(-1)!.body.base },
      { head: 'nagent/inc-1-x', base: 'main' },
    );
    assert.ok(!calls.some((c) => c.method !== 'GET' && /heads\/main/.test(c.url + JSON.stringify(c.body ?? ''))), 'never writes main');

    assert.equal(await gh.readFile('missing.txt'), null, '404 → null');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('GitLabRepo deletes the pushed branch when the merge request is refused (mocked fetch)', async () => {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const path = String(url).replace('https://gl.example/api/v4/projects/g%2Fp', '');
    calls.push(`${init.method} ${path.split('?')[0]}`);
    const reply = (data: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(data), { status });
    if (init.method === 'HEAD') return reply({}, 404);
    if (path === '/repository/commits') return reply({ id: 'c' }, 201);
    if (path === '/merge_requests') return reply({ error: 'insufficient_granular_scope' }, 403);
    if (init.method === 'DELETE') return reply(null, 204);
    return reply({ message: '404 Not Found' }, 404);
  }) as typeof fetch;
  try {
    const gl = new GitLabRepo('glpat-x', 'https://gl.example', 'g', 'p', 'dev', ['*']);
    await assert.rejects(
      gl.createPullRequest({ branch: 'nagent/inc-1-x', title: 't', body: 'b', draft: false, files: [{ path: 'run.sh', content: 'x' }] }),
      /HTTP 403\): insufficient_granular_scope .*branch nagent\/inc-1-x was deleted again/,
    );
    assert.equal(calls.at(-1), 'DELETE /repository/branches/nagent%2Finc-1-x');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('ollamaAnalyzer streams NDJSON from Ollama and validates the result (fake Ollama server)', async () => {
  const answer = JSON.stringify({ ...validJson, confidence: 40 });
  let requestBody: any;
  const installed = ['fake-model:latest'];
  const pulls: string[] = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/api/tags') {
      res.end(JSON.stringify({ models: installed.map((name) => ({ name })) }));
      return;
    }
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.url === '/api/pull') {
        const { model } = JSON.parse(raw);
        pulls.push(model);
        if (model === 'pullable-model') {
          installed.push('pullable-model:latest');
          res.end('{"status":"pulling manifest"}\n{"status":"downloading","completed":1}\n{"status":"success"}\n');
        } else res.end('{"error":"pull model manifest: file does not exist"}\n');
        return;
      }
      requestBody = JSON.parse(raw);
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      // Split the answer over several chunks, with a line break inside a chunk boundary.
      const parts = [answer.slice(0, 10), answer.slice(10, 50), answer.slice(50)];
      const lines = parts.map((p) => JSON.stringify({ message: { content: p }, done: false }) + '\n').join('') + JSON.stringify({ done: true }) + '\n';
      res.write(lines.slice(0, 25));
      setTimeout(() => res.end(lines.slice(25)), 20);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const prev = { url: config.ollamaBaseUrl, model: config.ollamaModel };
  config.ollamaBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  config.ollamaModel = 'fake-model';
  try {
    const { result, model } = await ollamaAnalyzer({ incident: { title: 't', description: 'd' } as Incident, files: [] });
    assert.equal(model, 'fake-model');
    assert.equal(result.confidence, 40);
    assert.equal(requestBody.stream, true);
    assert.equal(requestBody.format.type, 'object');
    assert.match(requestBody.messages[1].content, /<incident_report>/);
    assert.equal(requestBody.keep_alive, config.ollamaKeepAlive);

    // The correction round continues the conversation and only asks for the edits.
    const { revise } = await ollamaAnalyzer({ incident: { title: 't', description: 'd' } as Incident, files: [] });
    assert.deepEqual(await revise!('fix the find text'), validJson.proposedChanges);
    assert.deepEqual(Object.keys(requestBody.format.properties), ['proposedChanges']);
    assert.equal(requestBody.messages.at(-1).content, 'fix the find text');
    assert.equal(requestBody.messages.at(-2).role, 'assistant');

    config.ollamaModel = 'pullable-model';
    assert.equal((await ollamaAnalyzer({ incident: { title: 't', description: 'd' } as Incident, files: [] })).model, 'pullable-model');
    config.ollamaModel = 'missing-model';
    await assert.rejects(ollamaAnalyzer({ incident: { title: 't', description: 'd' } as Incident, files: [] }), /file does not exist.*ollama pull missing-model/);
    assert.deepEqual(pulls, ['pullable-model', 'missing-model'], 'missing models are downloaded automatically');
  } finally {
    config.ollamaBaseUrl = prev.url;
    config.ollamaModel = prev.model;
    await new Promise((r) => server.close(r));
  }
});

test('short infra terms are keywords, and Terraform blocks named in the report are recognized', () => {
  const incident = { title: 'module vpc not found', description: 'module.vpc.vpc_id fails; check var.cluster_name', logs: 'No module call named "network" is declared in the root module.' } as Incident;
  assert.ok(incidentKeywords(incident).includes('vpc'));
  assert.ok(!incidentKeywords(incident).includes('not'));
  assert.deepEqual(referencedBlocks(incident), [
    { kind: 'module', name: 'network' },
    { kind: 'module', name: 'vpc' },
    { kind: 'variable', name: 'cluster_name' },
  ]);
  assert.deepEqual(referencedBlocks({ title: 'module not found', description: 'variable is missing', logs: '' } as Incident), []);
});

test('staticFindings reports empty Terraform block names and unparsable YAML, but not Helm templates', () => {
  assert.deepEqual(staticFindings('main.tf', 'module "" {\n  source = "x"\n}\nresource "aws_vpc" "" {\n}\nmodule "ok" {\n}'), [
    'main.tf line 1: module block has an empty name: module "" {',
    'main.tf line 4: resource block has an empty name: resource "aws_vpc" "" {',
  ]);
  assert.equal(staticFindings('k8s/a.yaml', 'a: [1, 2\n').length, 1);
  assert.deepEqual(staticFindings('chart/templates/a.yaml', 'name: {{ .Values.name }\n'), []);
  assert.deepEqual(staticFindings('ok.yaml', 'a: 1\n'), []);
});

test('comment-only edits are rejected; uncommenting and commenting out code are real edits', () => {
  const originals = new Map([['main.tf', 'module "vpc" {\n  #enable_nat_gateway = true\n  single_nat_gateway = true\n}\n']]);
  const edit = (find: string, replace: string) => applyProposedChanges([{ file: 'main.tf', description: 'd', find, replace }], originals, ['*']);
  assert.match(edit('module "vpc" {', 'module "vpc" {\n  # Ensure the vpc module is defined').rejected[0].reason, /only adds or changes comments/);
  assert.equal(edit('#enable_nat_gateway = true', 'enable_nat_gateway = true').changes.length, 1);
  assert.equal(edit('single_nat_gateway = true', '# single_nat_gateway = true').changes.length, 1);
});
