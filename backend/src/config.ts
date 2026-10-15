import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';

function env(name: string, fallback = ''): string {
  return (process.env[name] ?? '').trim() || fallback;
}

function flag(name: string): boolean {
  return /^(1|true|yes|on)$/i.test(env(name));
}

function list(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim().replace(/^\.?\//, ''))
    .filter(Boolean);
}

/**
 * Physical CPU cores (Linux, incl. Docker): unique (physical id, core id) pairs in /proc/cpuinfo.
 * Undefined elsewhere — Ollama then picks the thread count itself.
 */
export function physicalCores(cpuinfo?: string): number | undefined {
  try {
    const cores = new Set<string>();
    let socket = '0';
    for (const line of (cpuinfo ?? readFileSync('/proc/cpuinfo', 'utf8')).split('\n')) {
      const [key, value] = line.split(':').map((s) => s.trim());
      if (key === 'physical id') socket = value;
      if (key === 'core id') cores.add(`${socket}:${value}`);
    }
    return cores.size || undefined;
  } catch {
    return undefined;
  }
}

/** Physical cores, limited to the CPUs this process may use (a container's cpuset still lists all host CPUs in /proc/cpuinfo). */
function usableCores(): number {
  return Math.min(physicalCores() ?? Infinity, availableParallelism());
}

/**
 * OLLAMA_NUM_THREAD, capped at this machine's cores: a value copied from a bigger machine's .env
 * (10 threads on a 4-core laptop or a 4-CPU Docker Desktop VM) makes the model several times slower.
 */
export function numThread(configured: number, cores = usableCores()): { threads?: number; capped: boolean } {
  if (!configured) return { threads: cores, capped: false };
  return configured > cores ? { threads: cores, capped: true } : { threads: configured, capped: false };
}
const threads = numThread(Number(env('OLLAMA_NUM_THREAD', '0')) || 0);

// Older .env files configured the repo as a URL; derive owner/repo from it when the new vars are absent.
const legacyRepo = env('GITHUB_REPO_URL').match(/github\.com[/:]([^/\s]+)\/([^/.\s]+)/i);

export const config = {
  port: Number(env('PORT', '8080')),
  /** Bound to localhost by default: the API has no user authentication (approve = create PR). */
  host: env('HOST', '127.0.0.1'),
  databaseUrl: env('DATABASE_URL', 'file:./data/opspilot.db'),

  ollamaBaseUrl: env('OLLAMA_BASE_URL', 'http://127.0.0.1:11434').replace(/\/+$/, ''),
  ollamaModel: env('OLLAMA_MODEL', 'qwen3:8b'),
  /** Context window. Larger values need much more RAM (KV cache) on CPU-only machines. */
  ollamaNumCtx: Number(env('OLLAMA_NUM_CTX', '8192')),
  /**
   * CPU threads for the model. Unset = all physical cores: Ollama's own choice on hybrid Intel CPUs
   * (12th gen+) is only the P-cores, e.g. 2 of 10 on an i5-1235U — several times slower.
   */
  ollamaNumThread: threads.threads,
  /** How long Ollama keeps the model in memory after a request; reloading it on CPU takes a minute or more. */
  ollamaKeepAlive: env('OLLAMA_KEEP_ALIVE', '30m'),
  /** Per model call. CPU-only machines (and Docker Desktop VMs) can need 10+ minutes per analysis. */
  aiTimeoutMs: Number(env('AI_TIMEOUT_MS', '1800000')),
  /** Force the rule-based demo analyzer for every investigation (no AI model is called). */
  demoMode: flag('DEMO_MODE'),

  githubToken: env('GITHUB_TOKEN'),
  githubOwner: env('GITHUB_OWNER', legacyRepo?.[1] ?? ''),
  githubRepo: env('GITHUB_REPO', legacyRepo?.[2] ?? ''),
  githubBaseBranch: env('GITHUB_BASE_BRANCH', env('GITHUB_REPO_REF', 'main')),
  /** Path prefixes the model may read and change. Empty = the whole repository (see normalizeRepo). */
  githubAllowedPaths: list(env('GITHUB_ALLOWED_PATHS')),
  /** Use an in-memory fake repository instead of GitHub (local testing of the PR flow). */
  githubMock: flag('GITHUB_MOCK'),

  /** GitLab.com or a self-managed instance. Incidents choose GitHub or GitLab when both are configured. */
  gitlabUrl: env('GITLAB_URL', 'https://gitlab.com').replace(/\/+$/, ''),
  gitlabToken: env('GITLAB_TOKEN'),
  /** Group or user; nested groups are written as "group/subgroup". */
  gitlabOwner: env('GITLAB_OWNER'),
  gitlabRepo: env('GITLAB_REPO'),
  gitlabBaseBranch: env('GITLAB_BASE_BRANCH', 'main'),
  gitlabAllowedPaths: list(env('GITLAB_ALLOWED_PATHS')),
  /** Local development only: open the PR without waiting for approval in the UI. */
  autoCreatePr: flag('AUTO_CREATE_PR'),

  teamsWebhookUrl: env('TEAMS_WEBHOOK_URL'),
  /** INTAKE_TOKEN is the previous name of this setting. */
  webhookSecret: env('WEBHOOK_SIGNING_SECRET', env('INTAKE_TOKEN')),
};

export type Provider = 'github' | 'gitlab';

/** Repository id: "github" / "gitlab" for the unnumbered settings, "github-2", "gitlab-3"… for numbered copies. */
export type RepoTarget = string;

export interface RepoSettings {
  id: RepoTarget;
  provider: Provider;
  token: string;
  owner: string;
  repo: string;
  baseBranch: string;
  allowedPaths: string[];
  /** GitLab instance URL (unused for GitHub). */
  url: string;
}

export const PROVIDER_LABELS: Record<Provider, string> = { github: 'GitHub', gitlab: 'GitLab' };

const SETTING = /^(GITHUB|GITLAB)_(TOKEN|OWNER|REPO|BASE_BRANCH|ALLOWED_PATHS|URL)_(\d+)$/;

/**
 * Additional repositories: the same settings with a numeric suffix, e.g. GITHUB_OWNER_2 / GITHUB_REPO_2 /
 * GITHUB_TOKEN_2 → repository "github-2".
 */
function numberedRepos(): RepoSettings[] {
  const found = new Map<string, { provider: Provider; n: string }>();
  for (const key of Object.keys(process.env)) {
    const m = key.match(SETTING);
    if (m && env(key)) found.set(`${m[1]}_${m[3]}`, { provider: m[1].toLowerCase() as Provider, n: m[3] });
  }
  return [...found.values()]
    .sort((a, b) => a.provider.localeCompare(b.provider) || Number(a.n) - Number(b.n))
    .map(({ provider, n }) => {
      const get = (name: string, fallback = '') => env(`${provider.toUpperCase()}_${name}_${n}`, fallback);
      return {
        id: `${provider}-${n}`,
        provider,
        token: get('TOKEN'),
        owner: get('OWNER'),
        repo: get('REPO'),
        baseBranch: get('BASE_BRANCH', 'main'),
        allowedPaths: list(get('ALLOWED_PATHS')),
        url: provider === 'gitlab' ? get('URL', 'https://gitlab.com').replace(/\/+$/, '') : '',
      };
    });
}

/** "https://gitlab.com/group/project" or "https:https://gitlab.com/…" → "https://gitlab.com". */
function serverUrl(value: string): string {
  const last = value.lastIndexOf('://');
  if (last < 0) return value.replace(/\/+$/, '');
  const start = value.lastIndexOf('http', last);
  try {
    return new URL(value.slice(start < 0 ? 0 : start)).origin;
  } catch {
    return value.replace(/\/+$/, '');
  }
}

/**
 * Accepts a repository URL pasted into *_REPO (https://github.com/owner/repo, git@…:owner/repo.git,
 * GitLab URLs with subgroups or "/-/tree/…"): owner and repo are taken from the URL.
 * Unset *_ALLOWED_PATHS means the whole repository ("*"); the deny list in repo.ts still applies.
 */
function normalizeRepo(r: RepoSettings): RepoSettings {
  const fromUrl = (value: string) => {
    const m = value.match(/^(?:https?:\/\/[^/]+\/|git@[^:]+:)(.+?)(?:\.git)?(?:\/-\/.*)?\/*$/);
    if (!m) return null;
    const parts = m[1].split('/').filter(Boolean);
    return parts.length >= 2 ? { owner: parts.slice(0, -1).join('/'), repo: parts.at(-1)! } : null;
  };
  const parsed = fromUrl(r.repo) ?? fromUrl(r.owner);
  return {
    ...r,
    ...(parsed ?? { owner: r.owner.replace(/^\/+|\/+$/g, ''), repo: r.repo.replace(/\.git$/, '') }),
    allowedPaths: r.allowedPaths.length ? r.allowedPaths : ['*'],
    url: r.provider === 'gitlab' ? serverUrl(r.url) : r.url,
  };
}

/** Every repository defined in the environment (configured or not); the unnumbered ones come first. */
export function repoSettings(): RepoSettings[] {
  return [
    {
      id: 'github',
      provider: 'github',
      token: config.githubToken,
      owner: config.githubOwner,
      repo: config.githubRepo,
      baseBranch: config.githubBaseBranch,
      allowedPaths: config.githubAllowedPaths,
      url: '',
    },
    {
      id: 'gitlab',
      provider: 'gitlab',
      token: config.gitlabToken,
      owner: config.gitlabOwner,
      repo: config.gitlabRepo,
      baseBranch: config.gitlabBaseBranch,
      allowedPaths: config.gitlabAllowedPaths,
      url: config.gitlabUrl,
    },
    ...numberedRepos(),
  ].map((r) => normalizeRepo(r as RepoSettings));
}

export function repoById(id: RepoTarget): RepoSettings | undefined {
  return repoSettings().find((r) => r.id === id);
}

/** Missing required variables for one repository, by their names in backend/.env. */
export function repoConfigProblems(id: RepoTarget): string[] {
  const r = repoById(id);
  if (!r) return [`unknown repository "${id}"`];
  const suffix = id.match(/-(\d+)$/)?.[1];
  const name = (k: string) => `${r.provider.toUpperCase()}_${k}${suffix ? `_${suffix}` : ''}`;
  return [!r.token && name('TOKEN'), !r.owner && name('OWNER'), !r.repo && name('REPO')].filter(Boolean) as string[];
}

export function githubConfigProblems(): string[] {
  return repoConfigProblems('github');
}

export function gitlabConfigProblems(): string[] {
  return repoConfigProblems('gitlab');
}

/** "GitHub owner/repo" for messages; falls back to the id when the repository is not configured. */
export function repoLabel(id: RepoTarget): string {
  const r = repoById(id);
  if (!r) return `Repository "${id}"`;
  return r.owner && r.repo ? `${PROVIDER_LABELS[r.provider]} ${r.owner}/${r.repo}` : `${PROVIDER_LABELS[r.provider]} (${id})`;
}

/** Repositories an incident can be reported against. In GITHUB_MOCK mode there is only the mock. */
export function configuredTargets(): RepoTarget[] {
  if (config.githubMock) return ['github'];
  return repoSettings()
    .filter((r) => !repoConfigProblems(r.id).length)
    .map((r) => r.id);
}

/** Used when an incident does not name a repository (alerts, older incidents). */
export function defaultTarget(): RepoTarget | undefined {
  return configuredTargets()[0];
}

export function startupWarnings(): string[] {
  const warnings: string[] = [];
  if (config.demoMode) warnings.push('DEMO_MODE=true — investigations use the rule-based demo analyzer, not AI');
  if (config.githubMock) warnings.push('GITHUB_MOCK=true — PRs are created in an in-memory fake repository');
  else if (githubConfigProblems().length) {
    warnings.push(`GitHub not configured (missing ${githubConfigProblems().join(', ')}) — patches are shown but no PR can be created`);
  }
  for (const r of config.githubMock ? [] : repoSettings().slice(1)) {
    const missing = repoConfigProblems(r.id);
    if (missing.length && missing.length < 3) warnings.push(`${repoLabel(r.id)} partly configured (missing ${missing.join(', ')}) — it is unavailable`);
  }
  if (!config.teamsWebhookUrl) warnings.push('TEAMS_WEBHOOK_URL not set — Teams notifications are skipped');
  if (!config.webhookSecret) warnings.push('WEBHOOK_SIGNING_SECRET not set — /api/webhooks/* rejects all requests');
  if (threads.capped) {
    warnings.push(`OLLAMA_NUM_THREAD=${env('OLLAMA_NUM_THREAD')} is more than this machine's ${threads.threads} CPU cores — using ${threads.threads}`);
  }
  if (config.autoCreatePr) warnings.push('AUTO_CREATE_PR=true — PRs are opened without approval');
  return warnings;
}
