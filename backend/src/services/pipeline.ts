import { config, REPO_LABELS, repoConfigProblems } from '../config.js';
import { addEvent, getIncident, updateIncident } from '../db.js';
import type { Analysis, Incident, Remediation } from '../types.js';
import { demoAnalyzer, groundEvidence, ollamaAnalyzer, type Analyzer, type RepoFile } from './ai.js';
import {
  applyProposedChanges,
  candidateFiles,
  rankByContent,
  rcaMarkdown,
  selectRelevantFiles,
  truncateForModel,
  unifiedDiff,
  validateChanges,
} from './patch.js';
import { getRepoProvider, RCA_DIR, type RepoProvider } from './repo.js';
import { notifyTeams, type TeamsEvent } from './teams.js';

/**
 * Investigation workflow:
 *   read relevant repo files → AI analysis (validated + grounded) → RCA → proposed patch →
 *   static validation → await approval → branch + commit + PR.
 */

let aiOverride: Analyzer | undefined;
/** Tests inject a fake analyzer here. */
export function setAnalyzer(analyzer: Analyzer | undefined): void {
  aiOverride = analyzer;
}

const running = new Set<string>();
const pending = new Map<string, Promise<void>>();

export function isRunning(id: string): boolean {
  return running.has(id);
}

/** Resolves when the in-flight investigation/PR creation for this incident (if any) finishes. */
export function whenIdle(id: string): Promise<void> {
  return pending.get(id) ?? Promise.resolve();
}

async function notify(event: TeamsEvent, id: string): Promise<void> {
  const incident = getIncident(id);
  if (!incident) return;
  const r = await notifyTeams(event, incident);
  if (config.teamsWebhookUrl) addEvent(id, 'notify', r.ok ? `Teams notified (${event})` : `Teams notification failed: ${r.detail}`);
}

export function notifyReceived(id: string): void {
  void notify('incident_received', id);
}

/**
 * Starts an investigation in the background. Returns false if one is already running.
 * With `announce`, the Teams "new incident" message is sent first and the agent starts only after
 * it was delivered (or failed — a Teams outage never blocks the investigation).
 */
export function startInvestigation(id: string, opts: { demo?: boolean; announce?: boolean } = {}): boolean {
  if (running.has(id)) return false;
  running.add(id);
  const run = async () => {
    if (opts.announce) await notify('incident_received', id);
    await investigate(id, opts);
  };
  const p = run().finally(() => {
    running.delete(id);
    pending.delete(id);
  });
  pending.set(id, p);
  return true;
}

/** "GitHub" / "GitLab" for messages; "Repository" when neither is configured. */
function repoLabel(incident: Incident): string {
  return incident.repoTarget ? REPO_LABELS[incident.repoTarget] : 'Repository';
}

/** GitLab calls them merge requests (!iid), GitHub pull requests (#number). */
function requestRef(kind: RepoProvider['kind'], number: number): string {
  return kind === 'gitlab' ? `MR !${number}` : `PR #${number}`;
}

/** Content search reads every allowed file (one API call each), so cap it for large allow-lists. */
const MAX_CONTENT_SEARCH = 300;

async function gatherFiles(id: string, incident: Incident, repo: RepoProvider): Promise<RepoFile[]> {
  const paths = await repo.listFiles();
  const read = async (path: string) => {
    const content = await repo.readFile(path);
    return content !== null && !content.includes('\u0000') ? { path, content } : null;
  };
  const selected = selectRelevantFiles(paths, incident, repo.allowedPaths);
  let files = (await Promise.all(selected.map(read))).filter((f): f is RepoFile => f !== null);

  // No file name matched: search the contents of the (small) set of allowed files instead.
  const candidates = candidateFiles(paths, repo.allowedPaths);
  if (!files.length && candidates.length > 0 && candidates.length <= MAX_CONTENT_SEARCH) {
    const all: RepoFile[] = [];
    for (let i = 0; i < candidates.length; i += 6) {
      all.push(...(await Promise.all(candidates.slice(i, i + 6).map(read))).filter((f): f is RepoFile => f !== null));
    }
    const ranked = new Set(rankByContent(all, incident));
    files = all.filter((f) => ranked.has(f.path));
    addEvent(id, 'repo', `No file name matched the report — searched the contents of ${all.length} allowed file(s)`);
  } else if (!files.length && candidates.length > MAX_CONTENT_SEARCH) {
    addEvent(id, 'repo', `No file name matched, and ${candidates.length} allowed files are too many to search — mention a file or module name in the report`);
  }
  addEvent(
    id,
    'repo',
    files.length
      ? `Read ${files.length} relevant file(s) from ${repo.name}@${repo.baseBranch}: ${files.map((f) => f.path).join(', ')}`
      : `No relevant files found in ${repo.name} within the allowed paths (${repo.allowedPaths.join(', ') || 'none'})`,
  );
  return files;
}

async function investigate(id: string, opts: { demo?: boolean }): Promise<void> {
  const demo = Boolean(opts.demo || config.demoMode);
  const incident = updateIncident(id, (i) => {
    i.status = 'investigating';
    i.error = undefined;
    i.analysis = undefined;
    i.remediation = undefined;
  });
  if (!incident) return;

  try {
    addEvent(id, 'analysis', demo ? 'Investigation started in DEMO MODE (no AI model)' : `Investigation started with Ollama model ${config.ollamaModel}`);

    const repo = getRepoProvider(incident.repoTarget);
    // Demo mode never sends repository contents anywhere and never proposes code changes.
    const files = repo && !demo ? await gatherFiles(id, incident, repo) : [];
    if (!repo) addEvent(id, 'repo', `${repoLabel(incident)} not configured — analyzing the incident report only`);

    const analyzer = aiOverride ?? (demo ? demoAnalyzer : ollamaAnalyzer);
    const started = Date.now();
    const modelFiles = files.map((f) => ({ path: f.path, content: truncateForModel(f.content) }));
    const { result, model } = await analyzer({ incident, files: modelFiles });
    const analysis = groundEvidence(result, { incident, files });

    updateIncident(id, (i) => {
      i.analysis = { mode: demo ? 'demo' : 'ollama', model, generatedAt: new Date().toISOString(), result: analysis };
      i.status = 'rca_ready';
    });
    addEvent(
      id,
      'analysis',
      `RCA generated in ${Math.round((Date.now() - started) / 1000)}s (confidence ${analysis.confidence}%, ` +
        `${analysis.evidence.filter((e) => e.type === 'fact').length} verified fact(s), ${analysis.proposedChanges.length} proposed change(s))`,
    );
    void notify('rca_ready', id);

    const current = getIncident(id)!;
    const remediation = buildRemediation(current, files, repo, demo);
    updateIncident(id, (i) => {
      i.analysis = current.analysis; // may carry Nagent's confidence adjustment
      i.remediation = remediation;
      i.status = remediation.status === 'awaiting_approval' ? 'awaiting_approval' : 'rca_ready';
    });
    for (const r of remediation.rejected) addEvent(id, 'patch', `Rejected model change to ${r.file}: ${r.reason}`);
    addEvent(id, 'patch', `Patch prepared: ${remediation.changes.map((c) => c.path).join(', ')}`);
    const failed = remediation.checks.filter((c) => c.status === 'failed').length;
    addEvent(
      id,
      'validation',
      `Validation: ${remediation.checks.filter((c) => c.status === 'passed').length} passed, ${failed} failed, ` +
        `${remediation.checks.filter((c) => c.status === 'skipped').length} skipped`,
    );
    if (remediation.message) addEvent(id, 'info', remediation.message);

    if (remediation.status === 'awaiting_approval' && config.autoCreatePr) {
      addEvent(id, 'pr', 'AUTO_CREATE_PR=true — creating the PR without manual approval');
      // Failures are recorded on the remediation (pr_failed); the investigation itself succeeded.
      await createPullRequest(id).catch(() => undefined);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateIncident(id, (i) => {
      i.status = 'failed';
      i.error = message;
    });
    addEvent(id, 'error', message);
    await notify('investigation_failed', id);
  }
}

/**
 * When the model proposed code edits but none could be applied, its root cause did not match the
 * actual code. Say so and lower the stated confidence (labeled) so the RCA is not over-trusted.
 */
function reconcile(analysis: Analysis, proposed: number, applied: number, rejected: Remediation['rejected']): Analysis {
  if (proposed === 0 || applied > 0) return analysis;
  const alreadyApplied = rejected.some((r) => /already applied/.test(r.reason));
  return {
    ...analysis,
    confidence: Math.min(analysis.confidence, 30),
    limitations: [
      ...analysis.limitations,
      alreadyApplied
        ? 'The proposed change is already present in the repository, so the repository is probably not the cause (check for drift between Terraform state and the real infrastructure). Confidence lowered to at most 30% by Nagent.'
        : "The model's proposed code change did not match the repository files, so its root cause is unconfirmed. Confidence lowered to at most 30% by Nagent.",
    ],
  };
}

function buildRemediation(incident: Incident, files: RepoFile[], repo: RepoProvider | null, demo: boolean): Remediation {
  const analysis = incident.analysis!;
  const allowed = repo?.allowedPaths ?? [];
  const originals = new Map(files.map((f) => [f.path, f.content]));
  const { changes, rejected } = repo
    ? applyProposedChanges(analysis.result.proposedChanges, originals, allowed)
    : {
        changes: [],
        rejected: analysis.result.proposedChanges.map((c) => ({
          file: c.file,
          reason: `${repoLabel(incident)} not configured — repository file could not be read, so the edit cannot be applied`,
        })),
      };

  if (repo) {
    analysis.result = reconcile(analysis.result, analysis.result.proposedChanges.length, changes.length, rejected);
  }
  const rcaPath = `${RCA_DIR}${incident.id}.md`;
  const rca = rcaMarkdown(incident, analysis.result, analysis.mode, analysis.model);
  changes.push({ path: rcaPath, description: 'Root-cause analysis document', before: '', after: rca, diff: unifiedDiff(rcaPath, '', rca) });

  const checks = validateChanges(changes, allowed);
  const base: Omit<Remediation, 'status'> = {
    provider: repo?.kind ?? 'none',
    repo: repo?.name,
    repoUrl: repo?.webUrl || undefined,
    baseBranch: repo?.baseBranch,
    changes,
    rejected,
    checks,
  };

  if (!repo) {
    return {
      ...base,
      status: 'not_configured',
      message: incident.repoTarget
        ? `${repoLabel(incident)} is not configured (missing ${repoConfigProblems(incident.repoTarget).join(', ') || 'settings'} in backend/.env). The proposed patch is shown, but no PR can be created.`
        : 'No repository is configured (set GITHUB_* or GITLAB_* in backend/.env). The proposed patch is shown, but no PR can be created.',
    };
  }
  if (checks.some((c) => c.status === 'failed')) {
    return { ...base, status: 'validation_failed', message: 'Validation failed — the patch cannot be submitted as a PR.' };
  }
  if (demo && repo.kind !== 'mock') {
    return {
      ...base,
      status: 'blocked',
      message: 'Demo analyses are not AI-generated, so they cannot be submitted to the real repository. Run an AI investigation to create a PR.',
    };
  }
  const codeChanges = changes.length - 1; // minus the RCA document
  return {
    ...base,
    status: 'awaiting_approval',
    message: codeChanges
      ? `Review the patch and approve to open a ${repo.kind === 'gitlab' ? 'merge' : 'pull'} request.`
      : rejected.length
        ? `No code change could be applied (see "Model suggestions not applied"). Approving opens a draft ${repo.kind === 'gitlab' ? 'MR' : 'PR'} containing only the RCA document.`
        : `No code change was proposed. Approving opens a draft ${repo.kind === 'gitlab' ? 'MR' : 'PR'} containing only the RCA document.`,
  };
}

export class ApprovalError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** Approval entry point: validates state, then creates branch + commit + PR. */
export async function approveAndCreatePr(id: string): Promise<Incident> {
  const incident = getIncident(id);
  if (!incident) throw new ApprovalError('Incident not found', 404);
  if (running.has(id)) throw new ApprovalError('An investigation or PR creation is already running', 409);
  const r = incident.remediation;
  if (!r) throw new ApprovalError('No proposed patch to approve — run the investigation first', 409);
  if (r.status === 'not_configured') throw new ApprovalError(r.message ?? `${repoLabel(incident)} is not configured`, 412);
  if (r.status === 'pr_created') throw new ApprovalError(`PR already created: ${r.pr?.url}`, 409);
  if (r.status !== 'awaiting_approval' && r.status !== 'pr_failed') {
    throw new ApprovalError(r.message ?? `Patch is not approvable (status: ${r.status})`, 409);
  }

  running.add(id);
  const p = createPullRequest(id).finally(() => {
    running.delete(id);
    pending.delete(id);
  });
  pending.set(id, p);
  await p;
  return getIncident(id)!;
}

async function createPullRequest(id: string): Promise<void> {
  const incident = getIncident(id);
  const repo = incident && getRepoProvider(incident.repoTarget);
  if (!incident?.remediation || !repo) {
    throw new ApprovalError(`${incident ? repoLabel(incident) : 'Repository'} is not configured`, 412);
  }
  const remediation = incident.remediation;
  if (remediation.provider !== repo.kind || remediation.repo !== repo.name) {
    throw new ApprovalError('Repository configuration changed since the patch was generated — retry the investigation', 409);
  }
  const branch = `nagent/${id.toLowerCase()}-${Date.now().toString(36)}`;
  updateIncident(id, (i) => {
    i.status = 'creating_pr';
    i.remediation!.status = 'creating_pr';
  });
  addEvent(id, 'pr', `Creating branch ${branch} on ${repo.name} and opening a ${repo.kind === 'gitlab' ? 'merge request' : 'PR'} against ${repo.baseBranch}`);

  const codeChanges = remediation.changes.filter((c) => !c.path.startsWith(RCA_DIR));
  const analysis = incident.analysis!;
  const title = codeChanges.length ? `fix(${id}): ${incident.title}` : `docs(${id}): RCA for ${incident.title}`;
  const checks = remediation.checks
    .map((c) => `- ${c.status === 'passed' ? '✅' : c.status === 'failed' ? '❌' : '⏭️'} \`${c.name}\` ${c.file ?? ''} — ${c.detail}`)
    .join('\n');
  const body = `${rcaMarkdown(incident, analysis.result, analysis.mode, analysis.model)}
## Static validation (run by Nagent before this PR)

${checks}

${codeChanges.length ? '' : '_No code change was proposed — this PR only adds the RCA document (opened as draft)._\n'}`;

  try {
    const pr = await repo.createPullRequest({
      branch,
      title: title.slice(0, 200),
      body: body.slice(0, 60_000),
      draft: codeChanges.length === 0,
      files: remediation.changes.map((c) => ({ path: c.path, content: c.after ?? '' })),
    });
    updateIncident(id, (i) => {
      i.status = 'pr_created';
      i.remediation!.status = 'pr_created';
      i.remediation!.branch = branch;
      i.remediation!.pr = { ...pr, mock: repo.kind === 'mock', draft: codeChanges.length === 0 };
      i.remediation!.message =
        repo.kind === 'mock'
          ? 'Mock PR created in the in-memory test repository (not a real GitHub PR).'
          : repo.kind === 'gitlab'
            ? 'Merge request opened.'
            : 'Pull request opened.';
    });
    addEvent(id, 'pr', `${repo.kind === 'mock' ? 'Mock ' : ''}${requestRef(repo.kind, pr.number)} created: ${pr.url}`);
    await notify('pr_created', id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateIncident(id, (i) => {
      i.status = 'awaiting_approval';
      i.remediation!.status = 'pr_failed';
      i.remediation!.message = `PR creation failed: ${message}`;
    });
    addEvent(id, 'error', `PR creation failed: ${message}`);
    throw new ApprovalError(`PR creation failed: ${message}`, 502);
  }
}
