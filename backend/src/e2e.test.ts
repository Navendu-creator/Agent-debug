import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, test } from 'node:test';
import { createApp } from './app.js';
import { config, repoById } from './config.js';
import { initDb } from './db.js';
import { setAnalyzer, whenIdle } from './services/pipeline.js';
import { getRepoProvider, MOCK_FILES, MockRepo, setRepoProvider } from './services/repo.js';
import type { Analysis } from './types.js';

// Everything external is mocked: the AI analyzer, the GitHub/GitLab repositories and the Teams webhook.
// Config is overridden so values from a developer's real .env are never used.

let base = '';
let server: http.Server;
let teams: http.Server;
const teamsEvents: string[] = [];

before(async () => {
  teams = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      teamsEvents.push(JSON.parse(body).event);
      res.end('ok');
    });
  });
  await new Promise<void>((r) => teams.listen(0, '127.0.0.1', r));

  Object.assign(config, {
    teamsWebhookUrl: `http://127.0.0.1:${(teams.address() as AddressInfo).port}/hook`,
    webhookSecret: 'test-secret',
    ollamaBaseUrl: 'http://127.0.0.1:9', // nothing listens here
    demoMode: false,
    githubMock: false,
    autoCreatePr: false,
    githubToken: '',
    githubOwner: '',
    githubRepo: '',
    gitlabToken: '',
    gitlabOwner: '',
    gitlabRepo: '',
  });
  // Numbered repositories (GITHUB_OWNER_2…) are read from the environment, so drop any from a real .env.
  for (const key of Object.keys(process.env)) {
    if (/^(GITHUB|GITLAB)_[A-Z_]+_\d+$/.test(key)) delete process.env[key];
  }
  initDb(':memory:');
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => teams.close(r));
});

beforeEach(() => {
  setAnalyzer(undefined);
  setRepoProvider(undefined);
  teamsEvents.length = 0;
});

async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

const fakeAnalysis: Analysis = {
  summary: 'payment-api requests time out waiting for a database connection.',
  probableRootCause: 'The database connection pool (maxConnections: 5) is exhausted under checkout load.',
  evidence: [
    { type: 'fact', statement: 'Logs show pool acquisition timeouts', quote: 'TimeoutError: ResourceRequest timed out' },
    { type: 'fact', statement: 'Pool size is configured to 5', quote: 'maxConnections: 5' },
    { type: 'fact', statement: 'Disk corruption was logged', quote: 'FATAL: disk corrupted' }, // invented → must be demoted
    { type: 'hypothesis', statement: 'Traffic grew after the last deploy' },
  ],
  confidence: 70,
  recommendedFix: 'Raise the pool size to 20.',
  preventiveActions: ['Alert on pool saturation'],
  proposedChanges: [
    { file: 'services/payment-api/config.yaml', description: 'Raise pool size', find: 'maxConnections: 5', replace: 'maxConnections: 20' },
    { file: '.github/workflows/ci.yml', description: 'Skip tests', find: 'echo test', replace: 'true' },
  ],
  validationPlan: ['Run a checkout load test'],
  limitations: [],
};

test('end-to-end: create → investigate → RCA → proposed fix → validate → approve → PR', async () => {
  const repo = new MockRepo();
  setRepoProvider(repo);
  let filesSeen: string[] = [];
  let teamsBeforeAgent: string[] = [];
  setAnalyzer(async ({ files }) => {
    teamsBeforeAgent = [...teamsEvents];
    filesSeen = files.map((f) => f.path);
    return { result: fakeAnalysis, model: 'fake-model' };
  });

  const created = await api('POST', '/api/incidents', {
    title: 'Checkout requests failing',
    description: 'payment-api returns 504 on /checkout',
    severity: 'high',
    service: 'payment-api',
    environment: 'production',
    logs: 'TimeoutError: ResourceRequest timed out\n    at Pool.acquire',
  });
  assert.equal(created.status, 201);
  const id = created.body.incident.id as string;
  assert.match(id, /^INC-/);

  await whenIdle(id);
  assert.deepEqual(teamsBeforeAgent, ['incident_received'], 'Teams is notified before the agent starts');
  const order = (await api('GET', `/api/incidents/${id}`)).body.incident.timeline.map((e: any) => e.type);
  assert.ok(order.indexOf('notify') < order.indexOf('analysis'), `timeline order: ${order}`);
  assert.ok(filesSeen.includes('services/payment-api/config.yaml'), `analyzer saw ${filesSeen}`);
  assert.ok(!filesSeen.some((f) => f.startsWith('.github/')), 'denied files are never sent to the model');

  const detail = await api('GET', `/api/incidents/${id}`);
  assert.equal(detail.status, 200);
  const incident = detail.body.incident;
  assert.equal(incident.status, 'awaiting_approval');
  assert.equal(incident.analysis.mode, 'ollama');
  const demoted = incident.analysis.result.evidence.find((e: any) => e.quote === 'FATAL: disk corrupted');
  assert.equal(demoted.type, 'hypothesis', 'fact with an invented quote is downgraded');
  assert.equal(incident.analysis.result.evidence.filter((e: any) => e.type === 'fact').length, 2);

  const rca = await api('GET', `/api/incidents/${id}/rca`);
  assert.equal(rca.status, 200);
  assert.match(rca.body.analysis.result.probableRootCause, /connection pool/);
  const remediation = rca.body.remediation;
  assert.equal(remediation.status, 'awaiting_approval');
  const configChange = remediation.changes.find((c: any) => c.path === 'services/payment-api/config.yaml');
  assert.match(configChange.diff, /^-\s+maxConnections: 5$/m);
  assert.match(configChange.diff, /^\+\s+maxConnections: 20$/m);
  assert.equal(configChange.after, undefined, 'file contents are not exposed by the API');
  assert.ok(remediation.changes.some((c: any) => c.path === `docs/incidents/${id}.md`));
  assert.deepEqual(remediation.rejected.map((r: any) => r.file), ['.github/workflows/ci.yml']);
  assert.ok(remediation.checks.length > 0);
  assert.ok(remediation.checks.every((c: any) => c.status !== 'failed'), JSON.stringify(remediation.checks));
  assert.equal(repo.pulls.length, 0, 'no PR before approval');

  const approved = await api('POST', `/api/incidents/${id}/approve`);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const done = approved.body.incident;
  assert.equal(done.status, 'pr_created');
  assert.equal(done.remediation.pr.mock, true);
  assert.match(done.remediation.pr.url, /^mock:\/\/github\/mock-owner\/mock-repo\/pull\/1$/);

  assert.equal(repo.pulls.length, 1);
  assert.equal(repo.pulls[0].base, 'main');
  assert.match(repo.pulls[0].branch, /^nagent\/inc-/);
  assert.match(repo.branches.get(repo.pulls[0].branch)!.get('services/payment-api/config.yaml')!, /maxConnections: 20/);
  assert.match(repo.files.get('services/payment-api/config.yaml')!, /maxConnections: 5/, 'base branch untouched');

  assert.equal((await api('POST', `/api/incidents/${id}/approve`)).status, 409, 'cannot create the PR twice');
  assert.equal((await api('POST', `/api/incidents/${id}/investigate`)).status, 409);
  await new Promise((r) => setTimeout(r, 50)); // let fire-and-forget notifications land
  for (const e of ['incident_received', 'rca_ready', 'pr_created']) assert.ok(teamsEvents.includes(e), `Teams ${e}: ${teamsEvents}`);
});

test('Ollama unavailable → clear failure, then explicit demo mode; no PR without GitHub', async () => {
  const created = await api('POST', '/api/incidents', {
    title: 'Orders API down',
    severity: 'critical',
    logs: 'Error: connect ECONNREFUSED 10.0.0.5:5432',
  });
  const id = created.body.incident.id;
  await whenIdle(id);

  let incident = (await api('GET', `/api/incidents/${id}`)).body.incident;
  assert.equal(incident.status, 'failed');
  assert.match(incident.error, /Ollama is not reachable/);
  assert.equal(incident.analysis, undefined, 'no fake analysis on failure');
  assert.equal((await api('GET', `/api/incidents/${id}/rca`)).status, 404);

  const retry = await api('POST', `/api/incidents/${id}/investigate`, { mode: 'demo' });
  assert.equal(retry.status, 202);
  await whenIdle(id);
  incident = (await api('GET', `/api/incidents/${id}`)).body.incident;
  assert.equal(incident.status, 'rca_ready');
  assert.equal(incident.analysis.mode, 'demo');
  assert.match(incident.analysis.result.summary, /DEMO MODE/);
  assert.equal(incident.remediation.status, 'not_configured');
  assert.equal(incident.remediation.pr, undefined);

  const approve = await api('POST', `/api/incidents/${id}/approve`);
  assert.equal(approve.status, 412);
  assert.match(approve.body.error, /No repository is configured \(set GITHUB_\* or GITLAB_\*/);
});

test('alert webhook: authentication, normalization, deduplication', async () => {
  setAnalyzer(async () => ({ result: { ...fakeAnalysis, proposedChanges: [] } }));
  setRepoProvider(null);
  const alert = {
    alertname: 'HighErrorRate',
    severity: 'P1',
    description: '5xx rate above 10%',
    service: 'checkout',
    environment: 'production',
    timestamp: '2026-10-13T10:00:00Z',
    logs: ['ERROR upstream connect error', 'ERROR 503'],
  };
  const raw = JSON.stringify(alert);

  assert.equal((await api('POST', '/api/webhooks/alerts', raw)).status, 401);
  assert.equal((await api('POST', '/api/webhooks/alerts', raw, { Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await api('POST', '/api/webhooks/alerts', raw, { 'X-Nagent-Signature': 'sha256=00' })).status, 401);

  const signature = `sha256=${createHmac('sha256', 'test-secret').update(raw).digest('hex')}`;
  const first = await api('POST', '/api/webhooks/alerts', raw, { 'X-Nagent-Signature': signature });
  assert.equal(first.status, 202);
  assert.equal(first.body.accepted, 1);
  const id = first.body.incidents[0].id;

  const incident = (await api('GET', `/api/incidents/${id}`)).body.incident;
  assert.equal(incident.title, '[checkout] HighErrorRate');
  assert.equal(incident.severity, 'critical');
  assert.equal(incident.source, 'alert-webhook');
  assert.match(incident.logs, /upstream connect error/);

  const again = await api('POST', '/api/webhooks/alerts', raw, { Authorization: 'Bearer test-secret' });
  assert.equal(again.status, 202);
  assert.equal(again.body.incidents[0].deduplicated, true);
  assert.equal(again.body.incidents[0].id, id);

  const bad = await api('POST', '/api/webhooks/alerts', { severity: 'high' }, { Authorization: 'Bearer test-secret' });
  assert.equal(bad.status, 400);
  await whenIdle(id);
});

test('request validation, 404s and health without secrets', async () => {
  const invalid = await api('POST', '/api/incidents', { title: '', severity: 'high' });
  assert.equal(invalid.status, 400);
  assert.ok(invalid.body.details.title);
  assert.equal((await api('POST', '/api/incidents', '{not json')).status, 400);
  assert.equal((await api('GET', '/api/incidents/INC-NOPE')).status, 404);
  assert.equal((await api('POST', '/api/incidents/INC-NOPE/investigate')).status, 404);
  assert.equal((await api('POST', '/api/incidents/INC-NOPE/approve')).status, 404);

  const list = await api('GET', '/api/incidents');
  assert.equal(list.status, 200);
  assert.ok(list.body.incidents.length >= 3);

  const health = await api('GET', '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.database.ok, true);
  assert.equal(health.body.ai.reachable, false);
  assert.equal(health.body.github.mode, 'none');
  assert.deepEqual(health.body.github.missing, ['GITHUB_TOKEN', 'GITHUB_OWNER', 'GITHUB_REPO']);
  const text = JSON.stringify(health.body);
  assert.ok(!text.includes('test-secret') && !text.includes('/hook'), 'health never exposes secrets or webhook URLs');
});

test('typo claimed in the report but not in the code → no change, explained, confidence lowered', async () => {
  setRepoProvider(new MockRepo());
  setAnalyzer(async () => ({
    result: {
      ...fakeAnalysis,
      evidence: [
        { type: 'fact', statement: 'Reporter says the pool is misnamed', quote: 'pool is named maxConection' },
        { type: 'fact', statement: 'Config sets the pool size', quote: 'maxConnections: 5' },
      ],
      confidence: 100,
      // Model copies the typo from the report; the file already has the correct value.
      proposedChanges: [
        { file: 'services/payment-api/config.yaml', description: 'Fix typo', find: 'maxConection: 5', replace: 'maxConnections: 5' },
      ],
    },
  }));
  const created = await api('POST', '/api/incidents', {
    title: 'payment-api config typo',
    description: 'pool is named maxConection which causes errors',
    service: 'payment-api',
    severity: 'medium',
  });
  const id = created.body.incident.id;
  await whenIdle(id);
  const incident = (await api('GET', `/api/incidents/${id}`)).body.incident;

  assert.equal(incident.remediation.changes.length, 1, 'only the RCA document');
  assert.match(incident.remediation.rejected[0].reason, /already applied/);
  assert.match(incident.remediation.message, /only the RCA document/);
  assert.equal(incident.analysis.result.confidence, 30);
  assert.ok(incident.analysis.result.limitations.some((l: string) => /drift/.test(l)));
  const sources = incident.analysis.result.evidence.map((e: any) => e.source);
  assert.deepEqual(sources, ['report', 'repository']);
});

/** Minimal GitLab API v4 for one project, backed by MOCK_FILES. Records every write. */
async function fakeGitLab(projectPath: string) {
  const writes: Array<{ path: string; body: any }> = [];
  const prefix = `/api/v4/projects/${encodeURIComponent(projectPath)}`;
  const seenTokens = new Set<string>();
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seenTokens.add(String(req.headers['private-token']));
      const reply = (data: unknown, status = 200, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify(data));
      };
      const url = new URL(req.url!, 'http://x');
      if (!req.url!.startsWith(prefix)) return reply({ message: '404 Project Not Found' }, 404);
      const path = req.url!.slice(prefix.length).split('?')[0];
      if (path === '/repository/tree') {
        const all = Object.keys(MOCK_FILES).map((p) => ({ path: p, type: 'blob' }));
        // Two pages, to exercise pagination via X-Next-Page.
        const page = Number(url.searchParams.get('page'));
        return reply(page === 1 ? all.slice(0, 2) : all.slice(2), 200, page === 1 ? { 'X-Next-Page': '2' } : {});
      }
      const file = path.match(/^\/repository\/files\/([^/]+)$/);
      if (file) {
        const content = MOCK_FILES[decodeURIComponent(file[1])];
        if (content === undefined || url.searchParams.get('ref') !== 'main') return reply({ message: '404 File Not Found' }, 404);
        return reply({ encoding: 'base64', size: content.length, content: Buffer.from(content).toString('base64') });
      }
      if (req.method === 'POST' && path === '/repository/commits') {
        writes.push({ path, body: JSON.parse(raw) });
        return reply({ id: 'abc' }, 201);
      }
      if (req.method === 'POST' && path === '/merge_requests') {
        writes.push({ path, body: JSON.parse(raw) });
        return reply({ iid: 3, web_url: `https://gitlab.example/${projectPath}/-/merge_requests/3` }, 201);
      }
      return reply({ message: '404 Not Found' }, 404);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, writes, seenTokens, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

test('GitLab project chosen per incident: investigate → approve → merge request on GitLab', async () => {
  const gl = await fakeGitLab('team/infra/payments');

  // Not configured yet → choosing GitLab is rejected up front.
  const rejected = await api('POST', '/api/incidents', { title: 'Checkout failing', repo: 'gitlab' });
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error, /Repository "gitlab" is not configured/);

  Object.assign(config, {
    gitlabUrl: gl.url,
    gitlabToken: 'glpat-test',
    gitlabOwner: 'team/infra',
    gitlabRepo: 'payments',
    gitlabBaseBranch: 'main',
    gitlabAllowedPaths: ['services/'],
  });
  try {
    const health = await api('GET', '/api/health');
    assert.equal(health.body.gitlab.configured, true);
    assert.equal(health.body.gitlab.repo, 'team/infra/payments');
    assert.equal(health.body.defaultRepo, 'gitlab', 'GitHub is not configured in tests, so GitLab is the default');
    assert.ok(!JSON.stringify(health.body).includes('glpat-test'), 'health never exposes the GitLab token');

    let filesSeen: string[] = [];
    setAnalyzer(async ({ files }) => {
      filesSeen = files.map((f) => f.path);
      return { result: fakeAnalysis, model: 'fake-model' };
    });
    const created = await api('POST', '/api/incidents', {
      title: 'Checkout requests failing',
      description: 'payment-api returns 504 on /checkout',
      service: 'payment-api',
      logs: 'TimeoutError: ResourceRequest timed out',
      repo: 'gitlab',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.incident.id as string;
    assert.equal(created.body.incident.repoTarget, 'gitlab');
    await whenIdle(id);

    const incident = (await api('GET', `/api/incidents/${id}`)).body.incident;
    assert.equal(incident.status, 'awaiting_approval', JSON.stringify(incident.timeline));
    assert.deepEqual(filesSeen, ['services/payment-api/config.yaml'], 'reads allowed files from GitLab (both tree pages)');
    assert.equal(incident.remediation.provider, 'gitlab');
    assert.equal(incident.remediation.repo, 'team/infra/payments');
    assert.equal(incident.remediation.repoUrl, `${gl.url}/team/infra/payments`);
    assert.equal(gl.writes.length, 0, 'nothing written before approval');

    const approved = await api('POST', `/api/incidents/${id}/approve`);
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    const pr = approved.body.incident.remediation.pr;
    assert.deepEqual(pr, { url: 'https://gitlab.example/team/infra/payments/-/merge_requests/3', number: 3, mock: false, draft: false });
    assert.equal(approved.body.incident.remediation.message, 'Merge request opened.');

    const [commit, mr] = gl.writes;
    assert.equal(commit.path, '/repository/commits');
    assert.match(commit.body.branch, /^nagent\/inc-/);
    assert.equal(commit.body.start_branch, 'main');
    assert.deepEqual(
      commit.body.actions.map((a: any) => [a.action, a.file_path]),
      [['update', 'services/payment-api/config.yaml'], ['create', `docs/incidents/${id}.md`]],
    );
    assert.match(commit.body.actions[0].content, /maxConnections: 20/);
    assert.equal(mr.path, '/merge_requests');
    assert.deepEqual({ source: mr.body.source_branch, target: mr.body.target_branch }, { source: commit.body.branch, target: 'main' });
    assert.doesNotMatch(mr.body.title, /^Draft:/);
    assert.deepEqual([...gl.seenTokens], ['glpat-test']);

    // Alerts can be routed to GitLab with ?repo=gitlab; unknown targets are rejected.
    const auth = { Authorization: 'Bearer test-secret' };
    setAnalyzer(async () => ({ result: { ...fakeAnalysis, proposedChanges: [] }, model: 'fake-model' }));
    const alert = await api('POST', '/api/webhooks/alerts?repo=gitlab', { alertname: 'HighLatency', service: 'payments' }, auth);
    assert.equal(alert.status, 202, JSON.stringify(alert.body));
    const alertId = alert.body.incidents[0].id;
    assert.equal((await api('GET', `/api/incidents/${alertId}`)).body.incident.repoTarget, 'gitlab');
    await whenIdle(alertId);
    assert.equal((await api('POST', '/api/webhooks/alerts?repo=bitbucket', { alertname: 'X' }, auth)).status, 400);
    assert.equal((await api('POST', '/api/webhooks/alerts?repo=github', { alertname: 'X' }, auth)).status, 400, 'GitHub not configured');
  } finally {
    Object.assign(config, { gitlabToken: '', gitlabOwner: '', gitlabRepo: '', gitlabAllowedPaths: [] });
    await new Promise((r) => gl.server.close(r));
  }
});

test('extra repositories via numbered settings (GITHUB_*_2, GITLAB_*_3) appear in health and the picker', async () => {
  const vars = {
    GITHUB_TOKEN_2: 'ghtok2',
    GITHUB_OWNER_2: 'adityayadav7838',
    GITHUB_REPO_2: 'retail-store-sample-app',
    GITHUB_ALLOWED_PATHS_2: '*',
    GITLAB_TOKEN_3: 'gltok3',
    GITLAB_OWNER_3: 'grp',
    GITLAB_REPO_3: 'svc',
    GITLAB_BASE_BRANCH_3: 'dev',
    GITLAB_URL_3: 'https://gitlab.example.com/',
    GITHUB_OWNER_4: 'half-configured', // no token/repo → not offered
  };
  Object.assign(process.env, vars);
  try {
    const health = (await api('GET', '/api/health')).body;
    assert.deepEqual(
      health.repos.map((r: any) => [r.id, r.provider, r.name, r.baseBranch]),
      [
        ['github-2', 'github', 'adityayadav7838/retail-store-sample-app', 'main'],
        ['gitlab-3', 'gitlab', 'grp/svc', 'dev'],
      ],
    );
    assert.equal(health.defaultRepo, 'github-2', 'first configured repository is the default');
    assert.ok(!JSON.stringify(health).includes('ghtok2') && !JSON.stringify(health).includes('gltok3'), 'tokens never exposed');

    const gl = getRepoProvider('gitlab-3')!;
    assert.equal(gl.webUrl, 'https://gitlab.example.com/grp/svc');
    assert.deepEqual(getRepoProvider('github-2')!.allowedPaths, ['*']);
    assert.equal(getRepoProvider('github-4'), null);

    const bad = await api('POST', '/api/incidents', { title: 'x failing', repo: 'github-4' });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /Repository "github-4" is not configured/);
    const hook = await api('POST', '/api/webhooks/alerts?repo=github-9', { alertname: 'X' }, { Authorization: 'Bearer test-secret' });
    assert.equal(hook.status, 400);
    assert.match(hook.body.error, /github-2, gitlab-3/);
  } finally {
    for (const k of Object.keys(vars)) delete process.env[k];
  }
});

test('quoted code in the report finds the file that contains it, even when the service name matches another file', async () => {
  const repo = new MockRepo(
    {
      'src/ui/chart/templates/istio-gateway.yml': 'apiVersion: networking.istio.io/v1\nkind: Gateway\nmetadata:\n  name: ui\n',
      'terraform/main.tf': 'module "vpc" {\n  source = "terraform-aws-modules/vpc/aws"\n  #enable_nat_gateway = true\n  single_nat_gateway = true\n}\n',
      'terraform/outputs.tf': 'output "vpc_id" {\n  value = module.vpc.vpc_id\n}\n',
    },
    ['*'],
  );
  setRepoProvider(repo);
  let seen: string[] = [];
  setAnalyzer(async ({ files }) => {
    seen = files.map((f) => f.path);
    return {
      result: {
        ...fakeAnalysis,
        evidence: [{ type: 'fact', statement: 'NAT gateway is commented out', quote: '#enable_nat_gateway = true' }],
        proposedChanges: [{ file: 'terraform/main.tf', description: 'Enable NAT', find: '#enable_nat_gateway = true', replace: 'enable_nat_gateway = true' }],
      },
      model: 'fake-model',
    };
  });
  const created = await api('POST', '/api/incidents', {
    title: '#enable_nat_gateway = true',
    description: 'do uncomment this',
    service: 'gateway',
    logs: '#enable_nat_gateway = true\ndo uncomment this as this cause network error',
  });
  const id = created.body.incident.id;
  await whenIdle(id);
  const incident = (await api('GET', `/api/incidents/${id}`)).body.incident;
  assert.equal(seen[0], 'terraform/main.tf', `model saw ${seen}`);
  assert.ok(incident.timeline.some((e: any) => /found in: terraform\/main\.tf \(exact line\)/.test(e.message)));
  const change = incident.remediation.changes.find((c: any) => c.path === 'terraform/main.tf');
  assert.match(change.diff, /^-\s+#enable_nat_gateway = true$/m);
  assert.match(change.diff, /^\+\s+enable_nat_gateway = true$/m);
  assert.equal(incident.analysis.result.evidence[0].source, 'repository', 'quote verified against the code');
  assert.equal(incident.analysis.result.confidence, 70, 'no cap: the evidence comes from the code');
});

test('repository URLs pasted into *_REPO / GITLAB_URL are reduced to owner, repo and server', () => {
  const vars = {
    GITHUB_TOKEN_3: 't',
    GITHUB_OWNER_3: 'PiyushVerma2197',
    GITHUB_REPO_3: 'https://github.com/PiyushVerma2197/Terraform-multicloud',
    GITHUB_TOKEN_5: 't',
    GITHUB_REPO_5: 'git@github.com:org/infra.git',
    GITLAB_TOKEN_6: 't',
    GITLAB_REPO_6: 'https://gitlab.example.com/grp/sub/svc/-/tree/dev',
    GITLAB_URL_6: 'https:https://gitlab.example.com/grp/sub/svc',
  };
  const saved = { ...config };
  Object.assign(process.env, vars);
  Object.assign(config, { gitlabToken: 't', gitlabOwner: 'priyanshusingh271180', gitlabRepo: 'container-hardening', gitlabUrl: 'https:https://gitlab.com/priyanshusingh271180/container-hardening' });
  try {
    const pick = (id: string) => {
      const r = repoById(id)!;
      return [r.owner, r.repo, r.url];
    };
    assert.deepEqual(pick('github-3'), ['PiyushVerma2197', 'Terraform-multicloud', '']);
    assert.deepEqual(pick('github-5'), ['org', 'infra', '']);
    assert.deepEqual(pick('gitlab-6'), ['grp/sub', 'svc', 'https://gitlab.example.com']);
    assert.deepEqual(pick('gitlab'), ['priyanshusingh271180', 'container-hardening', 'https://gitlab.com']);
  } finally {
    for (const k of Object.keys(vars)) delete process.env[k];
    Object.assign(config, saved);
  }
});

test('pasted YAML: the file containing all quoted lines wins over files sharing a generic line', async () => {
  const svc = (name: string, type: string) =>
    `apiVersion: v1\nkind: Service\nmetadata:\n  name: ${name}\nspec:\n  type: ${type}\n  selector:\n    app: ${name}\n  ports:\n    - port: 80\n`;
  setRepoProvider(
    new MockRepo(
      {
        'spring-petclinic/k8s/db.yml': svc('db', 'ClusterIP'), // shares "apiVersion: v1" / "kind: Service"
        'spring-petclinic/k8s/healthcheck.yaml': svc('health', 'ClusterIP'),
        'spring-petclinic/k8s/petclinic.yml': `apiVersion: apps/v1\nkind: Deployment\n---\n${svc('petclinic', 'Cluster')}`,
      },
      ['*'],
    ),
  );
  let seen: string[] = [];
  setAnalyzer(async ({ files }) => {
    seen = files.map((f) => f.path);
    return { result: { ...fakeAnalysis, proposedChanges: [] }, model: 'fake-model' };
  });
  const created = await api('POST', '/api/incidents', {
    title: 'service type not found',
    description: 'it should be ClusterIP, not Cluster',
    service: 'kubernetes service',
    logs: 'apiVersion: v1\nkind: Service\nmetadata:\n  name: petclinic\nspec:\n  type: Cluster\n  selector:\n    app: petclinic\n  ports:',
  });
  await whenIdle(created.body.incident.id);
  assert.equal(seen[0], 'spring-petclinic/k8s/petclinic.yml', `model saw ${seen}`);
});

test('an edit that does not apply is sent back to the model once, and the corrected edit becomes the patch', async () => {
  setRepoProvider(new MockRepo());
  const feedback: string[] = [];
  setAnalyzer(async () => ({
    result: {
      ...fakeAnalysis,
      // Quoted from the report, not the file — the typical small-model mistake.
      proposedChanges: [{ file: 'services/payment-api/config.yaml', description: 'Raise pool size', find: 'pool size 5', replace: 'pool size 20' }],
    },
    model: 'fake-model',
    revise: async (text) => {
      feedback.push(text);
      return [{ file: 'services/payment-api/config.yaml', description: 'Raise pool size', find: 'maxConnections: 5', replace: 'maxConnections: 20' }];
    },
  }));
  const created = await api('POST', '/api/incidents', { title: 'Checkout timeouts', description: 'payment-api pool exhausted', service: 'payment-api' });
  const id = created.body.incident.id;
  await whenIdle(id);
  const incident = (await api('GET', `/api/incidents/${id}`)).body.incident;
  assert.equal(feedback.length, 1, 'one correction round');
  assert.match(feedback[0], /services\/payment-api\/config\.yaml: the text to replace does not exist/);
  assert.equal(incident.status, 'awaiting_approval');
  const change = incident.remediation.changes.find((c: any) => c.path === 'services/payment-api/config.yaml');
  assert.match(change.diff, /^\+\s*maxConnections: 20$/m);
  assert.deepEqual(incident.remediation.rejected, []);
  assert.ok(incident.timeline.some((e: any) => /Corrected edit applies to services\/payment-api\/config\.yaml/.test(e.message)));
});

test('no correction round when the fix is already in the repository', async () => {
  setRepoProvider(new MockRepo());
  let revised = 0;
  setAnalyzer(async () => ({
    result: {
      ...fakeAnalysis,
      proposedChanges: [{ file: 'services/payment-api/config.yaml', description: 'x', find: 'maxConnections: 1', replace: 'maxConnections: 5' }],
    },
    model: 'fake-model',
    revise: async () => {
      revised++;
      return [];
    },
  }));
  const created = await api('POST', '/api/incidents', { title: 'Checkout timeouts', description: 'payment-api pool', service: 'payment-api' });
  await whenIdle(created.body.incident.id);
  assert.equal(revised, 0);
  const incident = (await api('GET', `/api/incidents/${created.body.incident.id}`)).body.incident;
  assert.match(incident.remediation.rejected[0].reason, /already applied/);
});

test('unset *_ALLOWED_PATHS means the whole repository (deny list still applies)', () => {
  const vars = { GITHUB_TOKEN_4: 't', GITHUB_OWNER_4: 'o', GITHUB_REPO_4: 'r', GITHUB_ALLOWED_PATHS_4: '' };
  Object.assign(process.env, vars);
  try {
    assert.deepEqual(repoById('github-4')!.allowedPaths, ['*']);
    assert.deepEqual(getRepoProvider('github-4')!.allowedPaths, ['*']);
  } finally {
    for (const k of Object.keys(vars)) delete process.env[k];
  }
});

test('"module vpc not found" with service "terraform": the file with the broken module block is read, not the first files of the folder', async () => {
  const tf = (body: string) => `${body}\n`;
  setRepoProvider(
    new MockRepo(
      {
        'terraform/addons.tf': tf('module "eks_addons_lbc" {\n  source = "aws-ia/eks-blueprints-addons/aws"\n  vpc_id = module.vpc.vpc_id\n}'),
        'terraform/argocd.tf': tf('resource "helm_release" "argocd" {\n  name = "argocd"\n}'),
        'terraform/locals.tf': tf('locals {\n  azs = ["us-east-1a"]\n  vpc_name = "retail-vpc"\n}'),
        'terraform/main.tf': tf('module "" {\n  source  = "terraform-aws-modules/vpc/aws"\n  version = "~> 5.0"\n  name = "${var.cluster_name}-vpc"\n}\n\nmodule "retail_app_eks" {\n  source = "terraform-aws-modules/eks/aws"\n  vpc_id = module.vpc.vpc_id\n}'),
        'terraform/outputs.tf': tf('output "vpc_id" {\n  value = module.vpc.vpc_id\n}\noutput "vpc_cidr" {\n  value = module.vpc.vpc_cidr_block\n}'),
        'terraform/README.md': '# VPC module\nThe vpc module creates the VPC. module vpc outputs vpc_id.\n',
      },
      ['*'],
    ),
  );
  let seen: string[] = [];
  let findings: string[] = [];
  setAnalyzer(async (input) => {
    seen = input.files.map((f) => f.path);
    findings = input.findings ?? [];
    return {
      result: { ...fakeAnalysis, proposedChanges: [{ file: 'terraform/main.tf', description: 'Name the VPC module', find: 'module "" {', replace: 'module "vpc" {' }] },
      model: 'fake-model',
    };
  });
  const created = await api('POST', '/api/incidents', {
    title: 'module vpc not found',
    description: 'module vpc not defined define vpc',
    service: 'terraform',
    logs: 'module vpc not defined define vpc "" their should be something defined',
  });
  const id = created.body.incident.id;
  await whenIdle(id);
  assert.equal(seen[0], 'terraform/main.tf', `model saw ${seen}`);
  assert.ok(findings.some((f) => /terraform\/main\.tf line 1: module block has an empty name/.test(f)), `findings: ${findings}`);
  assert.ok(findings.some((f) => /No module "vpc" is declared .* referenced as module\.vpc in/.test(f)), `findings: ${findings}`);
  const incident = (await api('GET', `/api/incidents/${id}`)).body.incident;
  assert.ok(incident.timeline.some((e: any) => /^Static checks: /.test(e.message)));
  const change = incident.remediation.changes.find((c: any) => c.path === 'terraform/main.tf');
  assert.match(change.diff, /^\+module "vpc" \{$/m);
});

test('an edit that only adds comments is rejected and sent back for correction', async () => {
  setRepoProvider(new MockRepo());
  const feedback: string[] = [];
  setAnalyzer(async () => ({
    result: {
      ...fakeAnalysis,
      proposedChanges: [{ file: 'services/payment-api/config.yaml', description: 'note', find: 'maxConnections: 5', replace: '# TODO: raise this\n    maxConnections: 5' }],
    },
    model: 'fake-model',
    revise: async (text) => {
      feedback.push(text);
      return [];
    },
  }));
  const created = await api('POST', '/api/incidents', { title: 'Checkout timeouts', description: 'payment-api pool', service: 'payment-api' });
  const id = created.body.incident.id;
  await whenIdle(id);
  const incident = (await api('GET', `/api/incidents/${id}`)).body.incident;
  assert.match(feedback[0] ?? '', /only adds or changes comments/);
  assert.deepEqual(incident.remediation.changes.map((c: any) => c.path), [`docs/incidents/${id}.md`]);
  assert.ok(incident.analysis.result.confidence <= 30);
  assert.ok(incident.analysis.result.limitations.some((l: string) => /only added comments/.test(l)));
});

test('small model gets the edit wrong: Nagent applies the unambiguous static fix instead of another model round', async () => {
  setRepoProvider(
    new MockRepo(
      {
        'terraform/addons.tf': 'module "eks_addons_lbc" {\n  source = "aws-ia/eks-blueprints-addons/aws"\n  vpc_id = module.vpc.vpc_id\n}\n',
        'terraform/main.tf': 'module "" {\n  source  = "terraform-aws-modules/vpc/aws"\n  version = "~> 5.0"\n}\n\nmodule "retail_app_eks" {\n  source = "terraform-aws-modules/eks/aws"\n  vpc_id = module.vpc.vpc_id\n}\n',
        'terraform/variables.tf': 'variable "region" {\n  default = "us-east-1"\n}\n',
      },
      ['*'],
    ),
  );
  let revised = 0;
  setAnalyzer(async () => ({
    result: {
      ...fakeAnalysis,
      evidence: [],
      confidence: 90,
      // Quoted from the report with collapsed whitespace — not a line of the file.
      proposedChanges: [{ file: 'terraform/main.tf', description: 'Name it', find: 'module "" {   source  = "terraform-aws-modules/vpc/aws"', replace: 'module "vpc" {' }],
    },
    model: 'llama3.2',
    revise: async () => {
      revised++;
      return [];
    },
  }));
  const created = await api('POST', '/api/incidents', {
    title: 'module "" { source = "terraform-aws-modules/vpc/aws" version = "~> 5.0"',
    description: 'module vpc is not found',
    service: 'terrafrom',
    logs: 'module "" {   source  = "terraform-aws-modules/vpc/aws"   version = "~> 5.0"\nis should be module "vpc"',
  });
  const id = created.body.incident.id;
  await whenIdle(id);
  const incident = (await api('GET', `/api/incidents/${id}`)).body.incident;
  assert.equal(revised, 0, 'no extra model round when a static fix exists');
  assert.equal(incident.status, 'awaiting_approval');
  const change = incident.remediation.changes.find((c: any) => c.path === 'terraform/main.tf');
  assert.match(change.diff, /^-module "" \{$/m);
  assert.match(change.diff, /^\+module "vpc" \{$/m);
  const facts = incident.analysis.result.evidence.filter((e: any) => e.type === 'fact' && e.source === 'repository');
  assert.ok(facts.some((f: any) => f.quote === 'module "" {'), JSON.stringify(incident.analysis.result.evidence));
  assert.equal(incident.analysis.result.confidence, 90, 'not capped: the evidence is verified against the code');
  assert.ok(incident.timeline.some((e: any) => /using the fix from Nagent's static check: terraform\/main\.tf: module "" \{ → module "vpc" \{/.test(e.message)));
});

test('code pasted on one line ("terraform { # required_version = …") finds the commented-out line in another folder', async () => {
  const versions = 'terraform {\n  required_version = ">= 1.5.0"\n  required_providers {\n    aws = { source = "hashicorp/aws" }\n  }\n}\n';
  const files: Record<string, string> = {
    'argocd-server/main.tf': 'terraform {\n # required_version = ">= 1.6.0"\n  required_providers {\n    helm = { source = "hashicorp/helm" }\n  }\n}\n',
    'argocd-server/variables.tf': 'variable "region" {\n  default = "us-east-1"\n}\n',
  };
  // Service "terraform" makes terraform/ the first place to look — more files than one search batch.
  for (const env of ['dev', 'prod', 'staging']) {
    files[`terraform/aws/environments/${env}/versions.tf`] = versions;
    files[`terraform/aws/environments/${env}/main.tf`] = `module "vpc" {\n  source = "../../modules/vpc"\n  name = "${env}"\n}\n`;
    files[`terraform/aws/environments/${env}/variables.tf`] = 'variable "terraform_version" {\n  default = "1.5.0"\n}\n';
  }
  setRepoProvider(new MockRepo(files, ['*']));
  let seen: string[] = [];
  let revised = 0;
  setAnalyzer(async ({ files: shown }) => {
    seen = shown.map((f) => f.path);
    return {
      result: {
        ...fakeAnalysis,
        evidence: [],
        // The model quotes the report, not the file.
        proposedChanges: [{ file: 'argocd-server/main.tf', description: 'Uncomment', find: 'terraform { # required_version = ">= 1.6.0"', replace: 'terraform { required_version = ">= 1.6.0"' }],
      },
      model: 'fake-model',
      revise: async () => {
        revised++;
        return [];
      },
    };
  });
  const created = await api('POST', '/api/incidents', {
    title: 'terraform { # required_version = ">= 1.6.0" required version should be declared its commented',
    description: 'terraform { # required_version = ">= 1.6.0" required version should be declared its commented',
    service: 'terraform',
    severity: 'critical',
  });
  const id = created.body.incident.id;
  await whenIdle(id);
  const incident = (await api('GET', `/api/incidents/${id}`)).body.incident;
  assert.equal(seen[0], 'argocd-server/main.tf', `model saw ${seen}`);
  assert.equal(revised, 0);
  const change = incident.remediation.changes.find((c: any) => c.path === 'argocd-server/main.tf');
  assert.ok(change, JSON.stringify(incident.timeline.map((e: any) => e.message), null, 1));
  assert.match(change.diff, /^- # required_version = ">= 1\.6\.0"$/m);
  assert.match(change.diff, /^\+ required_version = ">= 1\.6\.0"$/m);
  assert.ok(!incident.remediation.changes.some((c: any) => /versions\.tf$/.test(c.path)), 'the versions.tf files are left alone');
  assert.ok(incident.analysis.result.evidence.some((e: any) => e.type === 'fact' && e.source === 'repository' && e.quote === '# required_version = ">= 1.6.0"'));
  assert.ok(incident.timeline.some((e: any) => /found in: argocd-server\/main\.tf \(exact line\)/.test(e.message)));
});

test('stop analysis aborts the model request, marks the incident cancelled, and it can be re-run or deleted', async () => {
  setRepoProvider(null);
  let aborted = false;
  setAnalyzer(
    ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      }),
  );
  const id = (await api('POST', '/api/incidents', { title: 'Slow model run', severity: 'low' })).body.incident.id;
  for (let i = 0; i < 50 && (await api('GET', `/api/incidents/${id}`)).body.incident.status !== 'investigating'; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }

  const stop = await api('POST', `/api/incidents/${id}/cancel`);
  assert.equal(stop.status, 200);
  assert.ok(aborted, 'the analyzer signal was aborted');
  assert.equal(stop.body.incident.status, 'cancelled');
  assert.equal(stop.body.running, false);
  assert.equal(stop.body.incident.error, undefined, 'stopping is not a failure');
  assert.ok(stop.body.incident.timeline.some((e: { message: string }) => /stopped by the user/.test(e.message)));
  assert.equal((await api('POST', `/api/incidents/${id}/cancel`)).status, 409, 'nothing left to stop');
  assert.equal((await api('POST', '/api/incidents/INC-NOPE/cancel')).status, 404);

  setAnalyzer(async () => ({ result: { ...fakeAnalysis, proposedChanges: [] } }));
  assert.equal((await api('POST', `/api/incidents/${id}/investigate`)).status, 202, 'a stopped incident can be re-run');
  await whenIdle(id);
  assert.equal((await api('GET', `/api/incidents/${id}`)).body.incident.status, 'rca_ready');

  // Deleting a running investigation stops it first.
  setAnalyzer(({ signal }) => new Promise((_r, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')))));
  assert.equal((await api('POST', `/api/incidents/${id}/investigate`)).status, 202);
  const del = await api('DELETE', `/api/incidents/${id}`);
  assert.equal(del.status, 200);
  await whenIdle(id);
  assert.equal((await api('GET', `/api/incidents/${id}`)).status, 404);
  assert.ok(!(await api('GET', '/api/incidents')).body.incidents.some((i: { id: string }) => i.id === id));
  assert.equal((await api('DELETE', `/api/incidents/${id}`)).status, 404);
});

test('review actions: reject, assign, resolve, reopen and delete are recorded with the actor in the audit log', async () => {
  setRepoProvider(new MockRepo());
  setAnalyzer(async () => ({ result: fakeAnalysis }));
  const created = await api('POST', '/api/incidents', { title: 'Pool exhausted', severity: 'high', service: 'payment-api', owner: 'Asha' });
  const id = created.body.incident.id;
  assert.equal(created.body.incident.owner, 'Asha');
  await whenIdle(id);
  assert.equal((await api('GET', `/api/incidents/${id}`)).body.incident.status, 'awaiting_approval');

  const rejected = await api('POST', `/api/incidents/${id}/reject`, { actor: 'Navendu', reason: 'Pool size should come from config' });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.incident.status, 'rejected');
  assert.equal(rejected.body.incident.remediation.status, 'rejected');
  assert.equal((await api('POST', `/api/incidents/${id}/reject`, { actor: 'Navendu' })).status, 409, 'cannot reject twice');
  assert.equal((await api('POST', `/api/incidents/${id}/approve`, { actor: 'Navendu' })).status, 409, 'a rejected patch cannot be approved');

  const assigned = await api('PATCH', `/api/incidents/${id}`, { owner: 'Ravi', actor: 'Navendu' });
  assert.equal(assigned.body.incident.owner, 'Ravi');
  assert.equal((await api('PATCH', `/api/incidents/${id}`, { owner: '' })).body.incident.owner, undefined, 'empty owner unassigns');

  const resolved = await api('POST', `/api/incidents/${id}/resolve`, { actor: 'Navendu', note: 'Config changed manually' });
  assert.equal(resolved.body.incident.status, 'resolved');
  assert.ok(resolved.body.incident.resolvedAt);
  assert.equal((await api('POST', `/api/incidents/${id}/investigate`)).status, 409, 'reopen before re-investigating');
  const reopened = await api('POST', `/api/incidents/${id}/reopen`, { actor: 'Navendu' });
  assert.equal(reopened.body.incident.status, 'rejected', 'back to where it was');
  assert.equal(reopened.body.incident.resolvedAt, undefined);

  const summary = (await api('GET', '/api/incidents')).body.incidents.find((i: { id: string }) => i.id === id);
  assert.equal(summary.snippet, '');
  assert.equal(summary.owner, undefined);

  assert.equal((await api('DELETE', `/api/incidents/${id}?actor=Navendu`)).status, 200);
  const audit = (await api('GET', '/api/audit?limit=2000')).body.events as Array<{ incidentId: string; type: string; message: string; actor?: string; exists: boolean }>;
  const mine = audit.filter((e) => e.incidentId === id);
  assert.ok(mine.some((e) => e.type === 'approval' && e.actor === 'Navendu' && /rejected by Navendu: Pool size/.test(e.message)));
  assert.ok(mine.some((e) => e.type === 'status' && /Assigned to Ravi by Navendu/.test(e.message)));
  assert.ok(mine.some((e) => /Resolved by Navendu/.test(e.message)) && mine.some((e) => /Reopened by Navendu/.test(e.message)));
  const deletion = mine.find((e) => /deleted by Navendu/.test(e.message));
  assert.ok(deletion && !deletion.exists, 'the deletion survives in the audit log');
  assert.ok(mine.every((e) => !e.exists), 'events of a deleted incident are only the deletion record');
});

test('approval is recorded with the actor', async () => {
  setRepoProvider(new MockRepo());
  setAnalyzer(async () => ({ result: fakeAnalysis }));
  const id = (await api('POST', '/api/incidents', { title: 'Approve me', severity: 'low' })).body.incident.id;
  await whenIdle(id);
  const approved = await api('POST', `/api/incidents/${id}/approve`, { actor: 'Navendu' });
  assert.equal(approved.status, 200);
  assert.ok(approved.body.incident.timeline.some((e: { type: string; actor?: string }) => e.type === 'approval' && e.actor === 'Navendu'));
  const summary = (await api('GET', '/api/incidents')).body.incidents.find((i: { id: string }) => i.id === id);
  assert.ok(summary.fixedAt, 'time of the PR is exposed for time-to-fix');
  assert.equal((await api('POST', `/api/incidents/${id}/reject`, {})).status, 409, 'cannot reject after the PR exists');
});

test('Argo CD "containers: Required value": the lines the last commit deleted are restored, not the init container patched', async () => {
  const head = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: sonarqube
spec:
  template:
    spec:
      initContainers:
        - name: init-sysctl
          image: busybox:1.36
          securityContext:
            privileged: true

  

          ports:
            - containerPort: 9000

          startupProbe:
            httpGet:
              path: /api/system/status
              port: 9000
          readinessProbe:
            httpGet:
              path: /api/system/status
              port: 9000
          livenessProbe:
            httpGet:
              path: /api/system/status
              port: 9000
`;
  const before = head.replace('\n  \n\n', '\n\n      containers:\n        - name: sonarqube\n          image: sonarqube:community\n\n');
  const repo = new MockRepo({ 'k8s/sonarqube/sonarqube.yaml': head, 'k8s/postgres/postgres.yaml': 'kind: Service\n' }, ['*']);
  repo.history.set('k8s/sonarqube/sonarqube.yaml', [{ sha: '7e08ba2e0231a151b9d387cce81fbb9e132c18fb', message: 'checking sonar image', before }]);
  setRepoProvider(repo);
  let prompt: { findings?: string[]; recentChanges?: string[] } = {};
  let revised = 0;
  setAnalyzer(async (input) => {
    prompt = input;
    return {
      result: {
        ...fakeAnalysis,
        probableRootCause: "The init container has probes but its restartPolicy is not 'Always'.",
        evidence: [],
        confidence: 100,
        // What qwen3:8b proposed: applies, valid YAML, but the Deployment still has no containers.
        proposedChanges: [{
          file: 'k8s/sonarqube/sonarqube.yaml',
          description: 'Add the restartPolicy to the init container',
          find: '          ports:\n            - containerPort: 9000\n',
          replace: '          ports:\n            - containerPort: 9000\n          restartPolicy: Always\n',
        }],
      },
      model: 'qwen3:8b',
      revise: async () => {
        revised++;
        return [];
      },
    };
  });
  const error =
    'one or more synchronization tasks completed unsuccessfully, reason: error when patching "/dev/shm/3696791283": Deployment.apps "sonarqube" is invalid: ' +
    '[spec.template.spec.containers: Required value, spec.template.spec.initContainers[0].livenessProbe: Forbidden: may not be set for init containers without restartPolicy=Always, ' +
    'spec.template.spec.initContainers[0].readinessProbe: Forbidden: may not be set for init containers without restartPolicy=Always, ' +
    'spec.template.spec.initContainers[0].startupProbe: Forbidden: may not be set for init containers without restartPolicy=Always] (retried 5 times).';
  const created = await api('POST', '/api/incidents', {
    title: 'OutOfSync from HEAD (7e08ba2)',
    description: error,
    logs: `SyncError\nFailed last sync attempt to [7e08ba2e0231a151b9d387cce81fbb9e132c18fb]: ${error}`,
    service: 'sonarqube',
    severity: 'high',
  });
  const id = created.body.incident.id;
  await whenIdle(id);
  const incident = (await api('GET', `/api/incidents/${id}`)).body.incident;

  assert.ok(prompt.recentChanges?.some((c) => /commit 7e08ba2 "checking sonar image"/.test(c) && /^-\s+image: sonarqube:community$/m.test(c)), 'the model sees the commit that deleted the lines');
  assert.ok(prompt.findings?.some((f) => /containers: Required value/.test(f) && /initContainers\[0\] "init-sysctl"/.test(f)), JSON.stringify(prompt.findings));
  assert.equal(revised, 0, 'no extra model round: the restore is unambiguous and validated');
  assert.equal(incident.status, 'awaiting_approval');
  const change = incident.remediation.changes.find((c: any) => c.path === 'k8s/sonarqube/sonarqube.yaml');
  assert.match(change.diff, /^\+      containers:$/m);
  assert.match(change.diff, /^\+        - name: sonarqube$/m);
  assert.match(change.diff, /^\+          image: sonarqube:community$/m);
  assert.doesNotMatch(change.diff, /restartPolicy/);
  assert.ok(incident.remediation.checks.some((c: any) => c.name === 'kubernetes' && c.status === 'passed'));
  const result = incident.analysis.result;
  assert.match(result.probableRootCause, /Commit 7e08ba2 \("checking sonar image", the revision named in the report\) removed `containers:`/);
  assert.match(result.probableRootCause, /also clears the other 3 error\(s\) Nagent found in the file/);
  assert.ok(result.evidence.some((e: any) => e.type === 'fact' && e.source === 'repository' && /history check/.test(e.statement)), JSON.stringify(result.evidence));
  assert.ok(result.evidence.some((e: any) => e.type === 'hypothesis' && /its patch left the file invalid.*restartPolicy/.test(e.statement)));
  assert.ok(incident.timeline.some((e: any) => /model's change applies but does not fix the incident .*containers: Required value/.test(e.message)));
});

test('a model patch that applies but leaves the manifest invalid is sent back once, and never becomes approvable', async () => {
  const head = 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\nspec:\n  template:\n    spec:\n      initContainers:\n        - name: init\n          image: busybox\n          readinessProbe:\n            tcpSocket:\n              port: 80\n';
  setRepoProvider(new MockRepo({ 'deploy/web.yaml': head }, ['*'])); // no history: no static fix
  const wrong = [{ file: 'deploy/web.yaml', description: 'sidecar', find: '          image: busybox\n', replace: '          image: busybox\n          restartPolicy: Always\n' }];
  let feedback = '';
  setAnalyzer(async () => ({
    result: { ...fakeAnalysis, proposedChanges: wrong },
    revise: async (f) => {
      feedback = f;
      return wrong;
    },
  }));
  const id = (await api('POST', '/api/incidents', { title: 'web sync failed', description: 'spec.template.spec.containers: Required value', service: 'web' })).body.incident.id;
  await whenIdle(id);
  const incident = (await api('GET', `/api/incidents/${id}`)).body.incident;
  assert.match(feedback, /apply, but the patched files would still be rejected:\n- deploy\/web\.yaml: The Kubernetes API would still reject this manifest: Deployment "web": spec\.template\.spec\.containers: Required value/);
  assert.ok(incident.timeline.some((e: any) => /Corrected edit still fails validation/.test(e.message)));
  assert.equal(incident.remediation.status, 'validation_failed');
});

test('kustomize "missing kind in object": the kind and metadata the commit removed are restored together', async () => {
  const head = 'apiVersion: v1\nkind: PersistentVolumeClaim\nmetadata:\n  name: postgres-pvc\n\n---\napiVersion: apps/v1\n\n\nspec:\n  replicas: 1\n  template:\n    spec:\n      containers:\n        - name: postgres\n          image: postgres:15\n';
  const before = head.replace('apiVersion: apps/v1\n\n\nspec:', 'apiVersion: apps/v1\n\nkind: Deployment\nmetadata:\n  name: postgres\n  namespace: sonarqube\nspec:');
  const repo = new MockRepo({ 'k8s/sonarqube/postgres.yaml': head }, ['*']);
  repo.history.set('k8s/sonarqube/postgres.yaml', [{ sha: 'c028cc9aa', message: 'removed kind deployment', before }]);
  setRepoProvider(repo);
  setAnalyzer(async () => ({
    // What qwen3:8b proposed: the kind only, so the Deployment still has no metadata.name.
    result: { ...fakeAnalysis, evidence: [], proposedChanges: [{ file: 'k8s/sonarqube/postgres.yaml', description: 'Add kind', find: 'apiVersion: apps/v1\n', replace: 'apiVersion: apps/v1\nkind: Deployment\n' }] },
    revise: async () => assert.fail('no model round needed'),
  }));
  const id = (await api('POST', '/api/incidents', {
    title: 'ArgoCD sync failing for sonarqube: kustomize build error in postgres.yaml (missing kind)',
    description: 'ComparisonError since revision c028cc9',
    logs: "Error: accumulating resources: accumulation err='accumulating resources from 'postgres.yaml': missing kind in object {{apps/v1 } {{ } map[] map[]}}'",
    service: 'sonarqube',
  })).body.incident.id;
  await whenIdle(id);
  const incident = (await api('GET', `/api/incidents/${id}`)).body.incident;
  assert.equal(incident.status, 'awaiting_approval');
  const diff = incident.remediation.changes.find((c: any) => c.path === 'k8s/sonarqube/postgres.yaml').diff;
  for (const line of ['kind: Deployment', 'metadata:', '  name: postgres', '  namespace: sonarqube']) assert.match(diff, new RegExp(`^\\+${line}$`, 'm'));
  assert.ok(incident.timeline.some((e: any) => /does not fix the incident .*metadata\.name: Required value/.test(e.message)));
  assert.match(incident.analysis.result.probableRootCause, /Commit c028cc9 \("removed kind deployment", the revision named in the report\) removed `kind: Deployment`, `metadata:`/);
});
