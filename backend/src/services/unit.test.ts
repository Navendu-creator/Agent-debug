import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { config } from '../config.js';
import type { Incident } from '../types.js';
import { groundEvidence, ollamaAnalyzer, parseAnalysis } from './ai.js';
import { applyProposedChanges, rankByContent, unifiedDiff, validateChanges } from './patch.js';
import { assertSafeBranch, checkPath, GitHubRepo } from './repo.js';
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
  assert.match(g.limitations.at(-1)!, /2 model-claimed fact/);
});

test('checkPath enforces allow list and deny list', () => {
  assert.equal(checkPath('services/a.yaml', ['services/']), null);
  assert.equal(checkPath('docs/incidents/INC-1.md', []), null);
  assert.match(checkPath('src/a.ts', [])!, /GITHUB_ALLOWED_PATHS is empty/);
  assert.match(checkPath('other/a.ts', ['services/'])!, /outside/);
  assert.match(checkPath('../etc/passwd', ['services/'])!, /repository-relative/);
  assert.match(checkPath('services/../x', ['services/'])!, /repository-relative/);
  assert.match(checkPath('.github/workflows/ci.yml', ['.github/'])!, /deny list/);
  assert.match(checkPath('services/.env', ['services/'])!, /deny list/);
  assert.match(checkPath('services/tls.key', ['services/'])!, /deny list/);
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

test('ollamaAnalyzer streams NDJSON from Ollama and validates the result (fake Ollama server)', async () => {
  const answer = JSON.stringify({ ...validJson, confidence: 40 });
  let requestBody: any;
  const server = http.createServer((req, res) => {
    if (req.url === '/api/tags') {
      res.end(JSON.stringify({ models: [{ name: 'fake-model:latest' }] }));
      return;
    }
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
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

    config.ollamaModel = 'missing-model';
    await assert.rejects(ollamaAnalyzer({ incident: { title: 't', description: 'd' } as Incident, files: [] }), /ollama pull missing-model/);
  } finally {
    config.ollamaBaseUrl = prev.url;
    config.ollamaModel = prev.model;
    await new Promise((r) => server.close(r));
  }
});
