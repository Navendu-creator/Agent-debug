import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, test } from 'node:test';
import { createApp } from './app.js';
import { config } from './config.js';
import { initDb } from './db.js';
import { setAnalyzer, whenIdle } from './services/pipeline.js';
import { MOCK_FILES, MockRepo, setRepoProvider } from './services/repo.js';
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
  assert.match(rejected.body.error, /GitLab is not configured/);

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
