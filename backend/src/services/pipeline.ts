import { config, repoConfigProblems, repoLabel as labelOf } from '../config.js';
import { addEvent, getIncident, updateIncident } from '../db.js';
import type { Analysis, Incident, Remediation } from '../types.js';
import { demoAnalyzer, groundEvidence, ollamaAnalyzer, ollamaStatus, type Analyzer, type RepoFile } from './ai.js';
import {
  applyProposedChanges,
  candidateFiles,
  contentRank,
  escapeRe,
  incidentKeywords,
  quotedCode,
  quotedCodeScore,
  quotedCodeSearchOrder,
  rcaMarkdown,
  referencedBlocks,
  selectRelevantFiles,
  serviceFiles,
  truncateForModel,
  type ContentRank,
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

/** "GitHub owner/repo" for messages; "Repository" when no repository is configured. */
function repoLabel(incident: Incident): string {
  return incident.repoTarget ? labelOf(incident.repoTarget) : 'Repository';
}

/** GitLab calls them merge requests (!iid), GitHub pull requests (#number). */
function requestRef(kind: RepoProvider['kind'], number: number): string {
  return kind === 'gitlab' ? `MR !${number}` : `PR #${number}`;
}

/** The search reads allowed files one API call each, so cap it for large repositories. */
const MAX_CONTENT_SEARCH = 300;
/** Matches MAX_FILES in patch.ts: what fits in the model's context window. */
const MAX_FILES_FOR_MODEL = 3;

type Scanned = RepoFile & { quotedScore: number } & ContentRank;

/**
 * Picks the files to show the model by reading them, not by guessing from names: code quoted in the
 * report, files the report names, then a content ranking (keywords, where blocks named in the report
 * are declared, static findings such as `module "" {`). Files named in the report or under the service's
 * folder are read first; the scan stops once they produced a clear signal.
 */
async function gatherFiles(id: string, incident: Incident, repo: RepoProvider): Promise<{ files: RepoFile[]; findings: string[] }> {
  const paths = await repo.listFiles();
  const read = async (path: string) => {
    const content = await repo.readFile(path);
    return content !== null && !content.includes('\u0000') ? { path, content } : null;
  };
  const candidates = candidateFiles(paths, repo.allowedPaths);
  const named = selectRelevantFiles(paths, incident, repo.allowedPaths);
  const preferred = [...new Set([...named, ...serviceFiles(candidates, incident.service)])];
  const order = quotedCodeSearchOrder(candidates, preferred).slice(0, MAX_CONTENT_SEARCH);

  const quoted = quotedCode(incident);
  const hasQuoted = quoted.lines.length > 0 || quoted.identifiers.length > 0;
  // "#x = 1" and "x = 1" count as one line (quotedCodeScore ignores a leading comment marker).
  const distinctLines = new Set(quoted.lines.map((l) => l.replace(/\s+/g, ' ').trim().replace(/^(#|\/\/)\s*/, ''))).size;
  const keywords = incidentKeywords(incident);
  const refs = referencedBlocks(incident);

  const scanned: Scanned[] = [];
  for (let i = 0; i < order.length; i += 6) {
    const batch = (await Promise.all(order.slice(i, i + 6).map(read))).filter((f): f is RepoFile => f !== null);
    for (const f of batch) {
      scanned.push({ ...f, quotedScore: hasQuoted ? quotedCodeScore(f.content, quoted) : 0, ...contentRank(f, keywords, refs) });
    }
    // Generic quoted lines (`kind: Service`) match many files: stop only once one file has all of them.
    if (quoted.lines.length && scanned.some((s) => s.quotedScore >= distinctLines * 10)) break;
    const preferredDone = i + 6 >= preferred.length;
    if (preferredDone && scanned.some((s) => s.strong)) break;
    if (preferredDone && preferred.length && scanned.some((s) => preferred.includes(s.path) && s.score >= 4)) break;
  }

  const byQuote = scanned.filter((s) => s.quotedScore >= 10).sort((a, b) => b.quotedScore - a.quotedScore);
  const byName = named.map((p) => scanned.find((s) => s.path === p)).filter((s): s is Scanned => Boolean(s));
  const byContent = scanned
    .filter((s) => s.score + s.quotedScore > 0)
    .sort((a, b) => Number(b.strong) - Number(a.strong) || b.score + b.quotedScore - (a.score + a.quotedScore) || a.path.localeCompare(b.path));
  const chosen = [...new Set([...byQuote, ...byName, ...byContent])].slice(0, MAX_FILES_FOR_MODEL);

  if (hasQuoted) {
    const hits = scanned.filter((s) => s.quotedScore > 0).sort((a, b) => b.quotedScore - a.quotedScore);
    const what = [...quoted.lines.slice(0, 2), ...quoted.identifiers.slice(0, 3)].map((q) => `"${q.slice(0, 60)}"`).join(', ');
    addEvent(
      id,
      'repo',
      hits.length
        ? `Quoted code from the report (${what}) found in: ${hits.slice(0, MAX_FILES_FOR_MODEL).map((h) => `${h.path}${h.quotedScore >= 10 ? ' (exact line)' : ''}`).join(', ')}`
        : `Quoted code from the report (${what}) was not found in ${scanned.length} searched file(s)`,
    );
  }

  // Deterministic facts for the model: problems in the chosen files, and declarations that are missing.
  const findings = chosen.flatMap((f) => f.findings);
  for (const { kind, name } of refs) {
    if (kind === 'resource' || kind === 'data') continue;
    const ref = `${kind === 'variable' ? 'var' : kind}.${name}`;
    if (scanned.some((s) => new RegExp(`^\\s*${kind}\\s+"${escapeRe(name)}"`, 'mi').test(s.content))) continue;
    const usedIn = scanned.filter((s) => new RegExp(`\\b${escapeRe(ref)}\\b`).test(s.content)).map((s) => s.path);
    findings.push(
      `No ${kind} "${name}" is declared in the ${scanned.length} file(s) searched${usedIn.length ? `; it is referenced as ${ref} in ${usedIn.slice(0, 3).join(', ')}` : ''}`,
    );
  }
  if (findings.length) addEvent(id, 'repo', `Static checks: ${findings.slice(0, 3).join(' · ')}`);

  addEvent(
    id,
    'repo',
    chosen.length
      ? `Read ${chosen.length} relevant file(s) from ${repo.name}@${repo.baseBranch} (searched ${scanned.length} of ${candidates.length}): ${chosen.map((f) => f.path).join(', ')}`
      : `No relevant files found in ${repo.name} within the allowed paths (${repo.allowedPaths.join(', ') || 'none'}; searched ${scanned.length} of ${candidates.length} file(s))`,
  );
  return { files: chosen.map(({ path, content }) => ({ path, content })), findings: findings.slice(0, 10) };
}

/**
 * Small local models often get the edit slightly wrong (`find` quoted from the report instead of the
 * file, `find` == `replace`, a non-unique snippet). When none of the proposed edits apply, tell the
 * model why and ask once for corrected edits, instead of leaving only the RCA until a manual retry.
 */
async function reviseChanges(
  id: string,
  analysis: Analysis,
  files: RepoFile[],
  repo: RepoProvider,
  revise: (feedback: string) => Promise<Analysis['proposedChanges']>,
): Promise<Analysis> {
  const originals = new Map(files.map((f) => [f.path, f.content]));
  const first = applyProposedChanges(analysis.proposedChanges, originals, repo.allowedPaths);
  // "Already applied" is a finding (the repo already has the fix), not a mistake to correct.
  const fixable = first.rejected.filter((r) => !/already applied|RCA document/.test(r.reason));
  if (!analysis.proposedChanges.length || first.changes.length || !fixable.length) return analysis;

  addEvent(id, 'patch', `The model's proposed change did not apply (${fixable[0].file}: ${fixable[0].reason}) — asking it to correct the edit`);
  const feedback = [
    'Your proposedChanges could not be applied to the repository:',
    ...fixable.map((r) => `- ${r.file}: ${r.reason}`),
    '',
    `Files you may edit: ${files.map((f) => f.path).join(', ')}.`,
    '"find" must be copied character for character from one of those files (between its --- FILE --- markers), ' +
      'including indentation and any leading comment marker such as "#", and must occur exactly once in that file. ' +
      '"replace" is the full new text for that snippet and must differ from "find". ' +
      'Do not copy text from the incident report. If no file change is justified, return an empty array.',
    'Return ONLY {"proposedChanges": [...]}.',
  ].join('\n');
  try {
    const started = Date.now();
    const proposed = await revise(feedback);
    const second = applyProposedChanges(proposed, originals, repo.allowedPaths);
    const secs = Math.round((Date.now() - started) / 1000);
    if (!second.changes.length) {
      addEvent(id, 'patch', `Corrected edit still did not apply (${secs}s)${second.rejected[0] ? `: ${second.rejected[0].file}: ${second.rejected[0].reason}` : ' — the model proposed no change'}`);
      return analysis;
    }
    addEvent(id, 'patch', `Corrected edit applies to ${second.changes.map((c) => c.path).join(', ')} (${secs}s)`);
    return { ...analysis, proposedChanges: proposed };
  } catch (err) {
    addEvent(id, 'patch', `Correcting the edit failed: ${err instanceof Error ? err.message : String(err)}`);
    return analysis;
  }
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
    const { files, findings } = repo && !demo ? await gatherFiles(id, incident, repo) : { files: [], findings: [] };
    if (!repo) addEvent(id, 'repo', `${repoLabel(incident)} not configured — analyzing the incident report only`);

    const analyzer = aiOverride ?? (demo ? demoAnalyzer : ollamaAnalyzer);
    if (analyzer === ollamaAnalyzer) {
      const status = await ollamaStatus();
      if (status.reachable && !status.modelAvailable) {
        addEvent(id, 'analysis', `Model ${config.ollamaModel} is not downloaded yet — downloading it now (several GB on first start)`);
      }
    }
    const started = Date.now();
    const modelFiles = files.map((f) => ({ path: f.path, content: truncateForModel(f.content) }));
    const { result, model, revise } = await analyzer({ incident, files: modelFiles, findings });
    let analysis = groundEvidence(result, { incident, files });
    if (repo && revise && files.length) analysis = await reviseChanges(id, analysis, files, repo, revise);

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
  const commentsOnly = rejected.every((r) => /only adds or changes comments/.test(r.reason));
  return {
    ...analysis,
    confidence: Math.min(analysis.confidence, 30),
    limitations: [
      ...analysis.limitations,
      alreadyApplied
        ? 'The proposed change is already present in the repository, so the repository is probably not the cause (check for drift between Terraform state and the real infrastructure). Confidence lowered to at most 30% by Nagent.'
        : commentsOnly
          ? "The model's proposed change only added comments, so no fix was found in the files it was shown. Confidence lowered to at most 30% by Nagent."
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
