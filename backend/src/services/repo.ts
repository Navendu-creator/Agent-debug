import { config, defaultTarget, repoConfigProblems, type RepoTarget } from '../config.js';

/**
 * Repository access for remediation. `GitHubRepo` and `GitLabRepo` talk to the providers' REST APIs
 * (no local clone, nothing is executed); `MockRepo` is an in-memory fake used by tests and GITHUB_MOCK=true.
 */

export interface PullRequestInput {
  branch: string;
  title: string;
  body: string;
  draft: boolean;
  files: Array<{ path: string; content: string }>;
}

export interface RepoProvider {
  kind: 'github' | 'gitlab' | 'mock';
  name: string;
  /** Browser URL of the repository ('' for the mock). */
  webUrl: string;
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
  if (allowedPaths.includes('*')) return null; // "*" = whole repository (the deny list above still applies)
  const allowed = [RCA_DIR, ...allowedPaths];
  if (!allowed.some((prefix) => (prefix.endsWith('/') ? path.startsWith(prefix) : path === prefix || path.startsWith(`${prefix}/`)))) {
    return allowedPaths.length
      ? `path is outside the allowed paths (${allowedPaths.join(', ')})`
      : 'the allowed paths (GITHUB_ALLOWED_PATHS / GITLAB_ALLOWED_PATHS) are empty — only the RCA document may be written';
  }
  return null;
}

export function assertSafeBranch(branch: string, baseBranch: string): void {
  if (!/^nagent\/[a-z0-9._-]+$/.test(branch) || branch === baseBranch || ['main', 'master'].includes(branch)) {
    throw new Error(`Refusing to write to branch "${branch}" — only new nagent/* branches are allowed`);
  }
}

/**
 * The PR/MR call failed after the branch was pushed: delete that (new, nagent/*) branch so a retry
 * does not leave orphans behind. Returns the original error, annotated with the cleanup outcome.
 */
async function withBranchCleanup(err: unknown, branch: string, deleteBranch: () => Promise<unknown>): Promise<Error> {
  const message = err instanceof Error ? err.message : String(err);
  try {
    await deleteBranch();
    return new Error(`${message} (branch ${branch} was deleted again)`);
  } catch {
    return new Error(`${message} (branch ${branch} was left behind and could not be deleted — remove it manually)`);
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
  webUrl: string;
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
    this.webUrl = `https://github.com/${owner}/${repo}`;
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
    try {
      const pr = await this.api<{ html_url: string; number: number }>('POST', '/pulls', {
        title: input.title,
        head: input.branch,
        base: this.baseBranch,
        body: input.body,
        draft: input.draft,
      });
      return { url: pr.html_url, number: pr.number };
    } catch (err) {
      throw await withBranchCleanup(err, input.branch, () => this.api('DELETE', `/git/refs/heads/${input.branch}`));
    }
  }
}

// ---------- GitLab ----------

class GitLabError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** GitLab REST API v4 (gitlab.com or self-managed). Writes go to a new branch and a merge request. */
export class GitLabRepo implements RepoProvider {
  kind = 'gitlab' as const;
  name: string;
  webUrl: string;
  baseBranch: string;
  allowedPaths: string[];
  private readonly apiBase: string;

  constructor(
    private readonly token: string,
    baseUrl: string,
    owner: string,
    repo: string,
    baseBranch: string,
    allowedPaths: string[],
  ) {
    this.name = `${owner}/${repo}`;
    this.webUrl = `${baseUrl}/${owner}/${repo}`;
    this.apiBase = `${baseUrl}/api/v4/projects/${encodeURIComponent(this.name)}`;
    this.baseBranch = baseBranch;
    this.allowedPaths = allowedPaths;
  }

  private async request(method: string, path: string, body?: unknown): Promise<{ data: any; headers: Headers }> {
    const res = await fetch(`${this.apiBase}${path}`, {
      method,
      headers: {
        'PRIVATE-TOKEN': this.token,
        'User-Agent': 'nagent',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const data = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) {
      // GitLab error messages never contain the token; the URL path is safe to show.
      const raw = data?.message ?? data?.error ?? '';
      const detail = (typeof raw === 'string' ? raw : JSON.stringify(raw)).slice(0, 300);
      const hint =
        res.status === 401
          ? ' — GITLAB_TOKEN is invalid or expired.'
          : res.status === 403
            ? method === 'GET' || method === 'HEAD'
              ? ' — the token needs the "read_api" (or "api") scope and at least Reporter access to this project.'
              : ' — the token needs the "api" scope and at least Developer access to this project.'
            : res.status === 404 && /project not found/i.test(detail)
              ? ' — check GITLAB_OWNER/GITLAB_REPO (and GITLAB_URL for self-managed GitLab), and that the token can access this project.'
              : '';
      throw new GitLabError(`GitLab ${method} ${path.split('?')[0]} failed (HTTP ${res.status}): ${detail}${hint}`, res.status);
    }
    return { data, headers: res.headers };
  }

  private filePath(path: string): string {
    return `/repository/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(this.baseBranch)}`;
  }

  async listFiles(): Promise<string[]> {
    const files: string[] = [];
    // 100 entries per page; stop at 100 pages so a huge monorepo cannot stall the investigation.
    for (let page = 1; page <= 100; ) {
      const { data, headers } = await this.request(
        'GET',
        `/repository/tree?ref=${encodeURIComponent(this.baseBranch)}&recursive=true&per_page=100&page=${page}`,
      );
      const items = data as Array<{ path: string; type: string }>;
      files.push(...items.filter((t) => t.type === 'blob').map((t) => t.path));
      const next = Number(headers.get('x-next-page'));
      if (!next || items.length < 100) break;
      page = next;
    }
    return files;
  }

  async readFile(path: string): Promise<string | null> {
    try {
      const { data } = await this.request('GET', this.filePath(path));
      if (data.encoding !== 'base64' || typeof data.content !== 'string' || (data.size ?? 0) >= 200_000) return null;
      return Buffer.from(data.content, 'base64').toString('utf8');
    } catch (err) {
      if (err instanceof GitLabError && err.status === 404) return null;
      throw err;
    }
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await this.request('HEAD', this.filePath(path));
      return true;
    } catch (err) {
      if (err instanceof GitLabError && err.status === 404) return false;
      throw err;
    }
  }

  /** One commit that creates the new branch from the base branch, then a merge request back into it. */
  async createPullRequest(input: PullRequestInput): Promise<{ url: string; number: number }> {
    assertSafeBranch(input.branch, this.baseBranch);
    const actions = await Promise.all(
      input.files.map(async (f) => ({
        action: (await this.exists(f.path)) ? 'update' : 'create',
        file_path: f.path,
        content: f.content,
      })),
    );
    await this.request('POST', '/repository/commits', {
      branch: input.branch,
      start_branch: this.baseBranch,
      commit_message: input.title,
      actions,
    });
    try {
      const { data: mr } = await this.request('POST', '/merge_requests', {
        source_branch: input.branch,
        target_branch: this.baseBranch,
        title: input.draft ? `Draft: ${input.title}` : input.title,
        description: input.body,
        remove_source_branch: true,
      });
      return { url: mr.web_url, number: mr.iid };
    } catch (err) {
      throw await withBranchCleanup(err, input.branch, () =>
        this.request('DELETE', `/repository/branches/${encodeURIComponent(input.branch)}`),
      );
    }
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
  webUrl = '';
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

/** The repository for an incident's target; `undefined` means the default (first configured) target. */
export function getRepoProvider(target: RepoTarget | undefined = defaultTarget()): RepoProvider | null {
  if (override !== undefined) return override;
  if (config.githubMock) {
    sharedMock ??= new MockRepo(MOCK_FILES, config.githubAllowedPaths.length ? config.githubAllowedPaths : undefined);
    return sharedMock;
  }
  if (!target || repoConfigProblems(target).length) return null;
  if (target === 'gitlab') {
    return new GitLabRepo(
      config.gitlabToken,
      config.gitlabUrl,
      config.gitlabOwner,
      config.gitlabRepo,
      config.gitlabBaseBranch,
      config.gitlabAllowedPaths,
    );
  }
  return new GitHubRepo(
    config.githubToken,
    config.githubOwner,
    config.githubRepo,
    config.githubBaseBranch,
    config.githubAllowedPaths,
  );
}
