import 'dotenv/config';

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
  /** CPU-only machines need minutes per analysis. */
  aiTimeoutMs: Number(env('AI_TIMEOUT_MS', '600000')),
  /** Force the rule-based demo analyzer for every investigation (no AI model is called). */
  demoMode: flag('DEMO_MODE'),

  githubToken: env('GITHUB_TOKEN'),
  githubOwner: env('GITHUB_OWNER', legacyRepo?.[1] ?? ''),
  githubRepo: env('GITHUB_REPO', legacyRepo?.[2] ?? ''),
  githubBaseBranch: env('GITHUB_BASE_BRANCH', env('GITHUB_REPO_REF', 'main')),
  /** Path prefixes the model may change. Empty = only the generated RCA document. */
  githubAllowedPaths: list(env('GITHUB_ALLOWED_PATHS')),
  /** Use an in-memory fake repository instead of GitHub (local testing of the PR flow). */
  githubMock: flag('GITHUB_MOCK'),
  /** Local development only: open the PR without waiting for approval in the UI. */
  autoCreatePr: flag('AUTO_CREATE_PR'),

  teamsWebhookUrl: env('TEAMS_WEBHOOK_URL'),
  /** INTAKE_TOKEN is the previous name of this setting. */
  webhookSecret: env('WEBHOOK_SIGNING_SECRET', env('INTAKE_TOKEN')),
};

export function githubConfigProblems(): string[] {
  const missing = [
    !config.githubToken && 'GITHUB_TOKEN',
    !config.githubOwner && 'GITHUB_OWNER',
    !config.githubRepo && 'GITHUB_REPO',
  ].filter(Boolean) as string[];
  return missing;
}

export function startupWarnings(): string[] {
  const warnings: string[] = [];
  if (config.demoMode) warnings.push('DEMO_MODE=true — investigations use the rule-based demo analyzer, not AI');
  if (config.githubMock) warnings.push('GITHUB_MOCK=true — PRs are created in an in-memory fake repository');
  else if (githubConfigProblems().length) {
    warnings.push(`GitHub not configured (missing ${githubConfigProblems().join(', ')}) — patches are shown but no PR can be created`);
  }
  if (!config.teamsWebhookUrl) warnings.push('TEAMS_WEBHOOK_URL not set — Teams notifications are skipped');
  if (!config.webhookSecret) warnings.push('WEBHOOK_SIGNING_SECRET not set — /api/webhooks/* rejects all requests');
  if (config.autoCreatePr) warnings.push('AUTO_CREATE_PR=true — PRs are opened without approval');
  return warnings;
}
