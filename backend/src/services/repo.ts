import { config, githubConfigProblems } from '../config.js';

/**
 * Repository access for remediation. `GitHubRepo` talks to the GitHub REST API (no local clone,
 * nothing is executed); `MockRepo` is an in-memory fake used by tests and GITHUB_MOCK=true.
 */

export interface PullRequestInput {
  branch: string;
  title: string;
  body: string;
  draft: boolean;
  files: Array<{ path: string; content: string }>;
}

export interface RepoProvider {
  kind: 'github' | 'mock';
  name: string;
  baseBranch: string;
  allowedPaths: string[];
  listFiles(): Promise<string[]>;
  readFile(path: string): Promise<string | null>;
  createPullRequest(input: PullRequestInput): Promise<{ url: string; number: number }>;
}

export const RCA_DIR = 'docs/incidents/';

// ---------- path policy ----------

const DENIED = [
  /(^|\/)\.git(\/|$)/,
  /^\.github\//,
  /(^|\/)\.env(\.|$)/,
  /\.(pem|key|p12|pfx|jks|keystore|tfstate|tfstate\.backup)$/i,
  /(^|\/)(id_rsa|id_ed25519|credentials|secrets?)(\.|\/|$)/i,
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|\.terraform\.lock\.hcl)$/,
];

/** Repository-relative, no traversal, not denied, inside an allowed prefix (or the RCA directory). */
export function checkPath(path: string, allowedPaths: string[]): string | null {
  if (!path || path.length > 300) return 'invalid path';
  if (path.startsWith('/') || path.includes('\\') || path.split('/').some((p) => p === '..' || p === '.' || p === '')) {
    return 'path must be repository-relative without "..", "." or empty segments';
  }
  if (DENIED.some((re) => re.test(path))) return 'path is on the deny list (CI, secrets, keys, state or lock files)';
  const allowed = [RCA_DIR, ...allowedPaths];
  if (!allowed.some((prefix) => (prefix.endsWith('/') ? path.startsWith(prefix) : path === prefix || path.startsWith(`${prefix}/`)))) {
    return allowedPaths.length
      ? `path is outside GITHUB_ALLOWED_PATHS (${allowedPaths.join(', ')})`
      : 'GITHUB_ALLOWED_PATHS is empty — only the RCA document may be written';
  }
  return null;
}

export function assertSafeBranch(branch: string, baseBranch: string): void {
  if (!/^nagent\/[a-z0-9._-]+$/.test(branch) || branch === baseBranch || ['main', 'master'].includes(branch)) {
    throw new Error(`Refusing to write to branch "${branch}" — only new nagent/* branches are allowed`);
  }
}

// ---------- GitHub ----------

class GitHubError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export class GitHubRepo implements RepoProvider {
  kind = 'github' as const;
  name: string;
  baseBranch: string;
  allowedPaths: string[];

  constructor(
    private readonly token: string,
    private readonly owner: string,
    private readonly repo: string,
    baseBranch: string,
    allowedPaths: string[],
  ) {
    this.name = `${owner}/${repo}`;
    this.baseBranch = baseBranch;
    this.allowedPaths = allowedPaths;
  }

  private async api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`https://api.github.com/repos/${this.owner}/${this.repo}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'nagent',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const data = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) {
      // GitHub error messages never contain the token; the URL path is safe to show.
      const detail = [data?.message, data?.errors ? JSON.stringify(data.errors).slice(0, 300) : ''].filter(Boolean).join(' ');
      const hint =
        res.status === 403 && /not accessible by personal access token/i.test(detail)
          ? method === 'GET'
            ? ' — the token needs "Contents: Read" access to this repository.'
            : ' — the token is read-only: give it "Contents: Read and write" and "Pull requests: Read and write" on this repository.'
          : res.status === 401
            ? ' — GITHUB_TOKEN is invalid or expired.'
            : '';
      throw new GitHubError(`GitHub ${method} ${path.split('?')[0]} failed (HTTP ${res.status}): ${detail}${hint}`, res.status);
    }
    return data as T;
  }

  async listFiles(): Promise<string[]> {
    const data = await this.api<{ tree: Array<{ path: string; type: string; size?: number }> }>(
      'GET',
      `/git/trees/${encodeURIComponent(this.baseBranch)}?recursive=1`,
    );
    return data.tree.filter((t) => t.type === 'blob' && (t.size ?? 0) < 200_000).map((t) => t.path);
  }

  async readFile(path: string): Promise<string | null> {
    try {
      const data = await this.api<{ content?: string; encoding?: string }>(
        'GET',
        `/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(this.baseBranch)}`,
      );
      if (data.encoding !== 'base64' || typeof data.content !== 'string') return null;
      return Buffer.from(data.content, 'base64').toString('utf8');
    } catch (err) {
      if (err instanceof GitHubError && err.status === 404) return null;
      throw err;
    }
  }

  /** One commit on a new branch via the Git Data API, then a PR against the base branch. */
  async createPullRequest(input: PullRequestInput): Promise<{ url: string; number: number }> {
    assertSafeBranch(input.branch, this.baseBranch);
    const ref = await this.api<{ object: { sha: string } }>('GET', `/git/ref/heads/${encodeURIComponent(this.baseBranch)}`);
    const baseSha = ref.object.sha;
    const baseCommit = await this.api<{ tree: { sha: string } }>('GET', `/git/commits/${baseSha}`);
    const tree = await this.api<{ sha: string }>('POST', '/git/trees', {
      base_tree: baseCommit.tree.sha,
      tree: input.files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })),
    });
    const commit = await this.api<{ sha: string }>('POST', '/git/commits', {
      message: input.title,
      tree: tree.sha,
      parents: [baseSha],
    });
    await this.api('POST', '/git/refs', { ref: `refs/heads/${input.branch}`, sha: commit.sha });
    const pr = await this.api<{ html_url: string; number: number }>('POST', '/pulls', {
      title: input.title,
      head: input.branch,
      base: this.baseBranch,
      body: input.body,
      draft: input.draft,
    });
    return { url: pr.html_url, number: pr.number };
  }
}

// ---------- mock ----------

export const MOCK_FILES: Record<string, string> = {
  'services/payment-api/config.yaml': `service: payment-api
database:
  host: postgres.internal
  port: 5432
  pool:
    maxConnections: 5
    acquireTimeoutMs: 1000
redis:
  url: redis://redis-master:6379
http:
  port: 8080
  requestTimeoutMs: 3000
`,
  'deploy/payment-api.yaml': `apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-api
spec:
  replicas: 2
  template:
    spec:
      containers:
        - name: payment-api
          image: registry.local/payment-api:1.4.2
          resources:
            limits:
              memory: 128Mi
              cpu: 500m
`,
  'services/payment-api/README.md': '# payment-api\n\nHandles card payments. Config lives in config.yaml.\n',
  '.github/workflows/ci.yml': 'name: ci\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo test\n',
};

export class MockRepo implements RepoProvider {
  kind = 'mock' as const;
  name = 'mock-owner/mock-repo';
  baseBranch = 'main';
  allowedPaths: string[];
  files: Map<string, string>;
  branches = new Map<string, Map<string, string>>();
  pulls: Array<PullRequestInput & { number: number; base: string }> = [];

  constructor(files: Record<string, string> = MOCK_FILES, allowedPaths = ['services/', 'deploy/']) {
    this.files = new Map(Object.entries(files));
    this.allowedPaths = allowedPaths;
  }

  async listFiles() {
    return [...this.files.keys()];
  }

  async readFile(path: string) {
    return this.files.get(path) ?? null;
  }

  async createPullRequest(input: PullRequestInput) {
    assertSafeBranch(input.branch, this.baseBranch);
    if (this.branches.has(input.branch)) throw new Error(`Branch ${input.branch} already exists`);
    const snapshot = new Map(this.files);
    for (const f of input.files) snapshot.set(f.path, f.content);
    this.branches.set(input.branch, snapshot);
    const number = this.pulls.length + 1;
    this.pulls.push({ ...input, number, base: this.baseBranch });
    return { url: `mock://github/${this.name}/pull/${number}`, number };
  }
}

// ---------- selection ----------

let override: RepoProvider | null | undefined;
let sharedMock: MockRepo | undefined;

/** Tests inject a provider here; `undefined` restores env-based selection. */
export function setRepoProvider(provider: RepoProvider | null | undefined): void {
  override = provider;
}

export function getRepoProvider(): RepoProvider | null {
  if (override !== undefined) return override;
  if (config.githubMock) {
    sharedMock ??= new MockRepo(MOCK_FILES, config.githubAllowedPaths.length ? config.githubAllowedPaths : undefined);
    return sharedMock;
  }
  if (githubConfigProblems().length) return null;
  return new GitHubRepo(
    config.githubToken,
    config.githubOwner,
    config.githubRepo,
    config.githubBaseBranch,
    config.githubAllowedPaths,
  );
}
