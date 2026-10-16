import { config, repoConfigProblems, repoLabel as labelOf } from '../config.js';
import { addEvent, deleteIncident, getIncident, updateIncident } from '../db.js';
import type { Analysis, Evidence, FileChange, Incident, ProposedChange, Remediation, ValidationCheck } from '../types.js';
import { CancelledError, demoAnalyzer, groundEvidence, ollamaAnalyzer, ollamaStatus, type Analyzer, type RepoFile } from './ai.js';
import {
  applyProposedChanges,
  candidateFiles,
  contentRank,
  emptyNameFixes,
  escapeRe,
  incidentKeywords,
  quotedCode,
  quotedCodeScore,
  quotedCodeSearchOrder,
  quotedLineCount,
  rcaMarkdown,
  recentChange,
  referencedBlocks,
  restoreFixes,
  selectRelevantFiles,
  serviceFiles,
  truncateForModel,
  uncommentFixes,
  type ContentRank,
  unifiedDiff,
  validateChanges,
} from './patch.js';
import { k8sProblems, requiredKeys } from './k8s.js';
import { getRepoProvider, RCA_DIR, type FileRevision, type RepoProvider } from './repo.js';
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
/** Investigations that can be stopped (PR creation cannot: it must not leave a half-pushed branch). */
const controllers = new Map<string, AbortController>();

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
  const controller = new AbortController();
  controllers.set(id, controller);
  const run = async () => {
    if (opts.announce) await notify('incident_received', id);
    await investigate(id, { ...opts, signal: controller.signal });
  };
  const p = run().finally(() => {
    running.delete(id);
    pending.delete(id);
    controllers.delete(id);
  });
  pending.set(id, p);
  return true;
}

export class ActionError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** Waits for the in-flight work to wind down, but never blocks the caller for long. */
async function settle(id: string, maxMs = 5000): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([whenIdle(id), new Promise<void>((r) => (timer = setTimeout(r, maxMs)))]);
  clearTimeout(timer);
}

const by = (actor?: string) => (actor ? ` by ${actor}` : '');

/**
 * Stops a running investigation: the Ollama request is aborted (freeing the CPU) and the incident is
 * marked `cancelled`, ready to be investigated again.
 */
export async function cancelInvestigation(id: string, actor?: string): Promise<Incident> {
  const incident = getIncident(id);
  if (!incident) throw new ActionError('Incident not found', 404);
  const controller = controllers.get(id);
  if (incident.status === 'creating_pr' || (running.has(id) && !controller)) {
    throw new ActionError('A pull request is being created and cannot be stopped', 409);
  }
  if (!controller) throw new ActionError('No investigation is running for this incident', 409);
  if (!controller.signal.aborted) {
    addEvent(id, 'info', `Stop requested${by(actor)} — cancelling the investigation`, actor);
    controller.abort();
  }
  await settle(id);
  return getIncident(id)!;
}

/** Deletes an incident, stopping its investigation first. Pull requests already opened are not touched. */
export async function removeIncident(id: string, actor?: string): Promise<void> {
  if (!getIncident(id)) throw new ActionError('Incident not found', 404);
  if (running.has(id)) {
    const controller = controllers.get(id);
    if (!controller || getIncident(id)?.status === 'creating_pr') {
      throw new ActionError('A pull request is being created — wait for it to finish before deleting', 409);
    }
    controller.abort();
    await settle(id);
  }
  deleteIncident(id, actor);
}

/** A reviewer declines the proposed patch. The incident stays open; a new investigation proposes a new patch. */
export function rejectPatch(id: string, actor?: string, reason?: string): Incident {
  const incident = getIncident(id);
  if (!incident) throw new ActionError('Incident not found', 404);
  if (running.has(id)) throw new ActionError('Wait for the running investigation or PR creation to finish', 409);
  const r = incident.remediation;
  if (!r) throw new ActionError('There is no proposed patch to reject', 409);
  if (r.status === 'pr_created') throw new ActionError('The pull request was already created — close it on the repository instead', 409);
  if (r.status === 'rejected') throw new ActionError('The patch was already rejected', 409);
  updateIncident(id, (i) => {
    i.status = 'rejected';
    i.remediation!.status = 'rejected';
    i.remediation!.message = `Patch rejected${by(actor)}${reason ? `: ${reason}` : ''}. Re-run the investigation for a new proposal.`;
  });
  return addEvent(id, 'approval', `Patch rejected${by(actor)}${reason ? `: ${reason}` : ''}`, actor)!;
}

/** Closes the incident (the fix was merged or the problem went away). */
export function resolveIncident(id: string, actor?: string, note?: string): Incident {
  const incident = getIncident(id);
  if (!incident) throw new ActionError('Incident not found', 404);
  if (running.has(id)) throw new ActionError('Stop or wait for the running work before resolving', 409);
  if (incident.status === 'resolved') throw new ActionError('The incident is already resolved', 409);
  updateIncident(id, (i) => {
    i.status = 'resolved';
    i.resolvedAt = new Date().toISOString();
  });
  return addEvent(id, 'status', `Resolved${by(actor)}${note ? `: ${note}` : ''}`, actor)!;
}

/** Re-opens a resolved incident, back to where its work stopped. */
export function reopenIncident(id: string, actor?: string): Incident {
  const incident = getIncident(id);
  if (!incident) throw new ActionError('Incident not found', 404);
  if (incident.status !== 'resolved') throw new ActionError('Only resolved incidents can be reopened', 409);
  const r = incident.remediation;
  updateIncident(id, (i) => {
    i.resolvedAt = undefined;
    i.status =
      r?.status === 'pr_created' ? 'pr_created'
      : r?.status === 'rejected' ? 'rejected'
      : r?.status === 'awaiting_approval' || r?.status === 'pr_failed' ? 'awaiting_approval'
      : i.analysis ? 'rca_ready'
      : 'open';
  });
  return addEvent(id, 'status', `Reopened${by(actor)}`, actor)!;
}

export function assignOwner(id: string, owner: string | undefined, actor?: string): Incident {
  const incident = getIncident(id);
  if (!incident) throw new ActionError('Incident not found', 404);
  if ((incident.owner ?? '') === (owner ?? '')) return incident;
  updateIncident(id, (i) => {
    i.owner = owner;
  });
  return addEvent(id, 'status', owner ? `Assigned to ${owner}${by(actor)}` : `Unassigned${by(actor)}`, actor)!;
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
/** Commits per file searched for the change that removed a required line. */
const HISTORY_DEPTH = 3;

type Scanned = RepoFile & { quotedScore: number } & ContentRank;

/**
 * Picks the files to show the model by reading them, not by guessing from names: code quoted in the
 * report, files the report names, then a content ranking (keywords, where blocks named in the report
 * are declared, static findings such as `module "" {`). Files named in the report or under the service's
 * folder are read first; the scan stops once they produced a clear signal.
 */
interface Gathered {
  files: RepoFile[];
  findings: string[];
  /** Facts from Nagent's own checks, each with a quote that is in the repository. */
  facts: Evidence[];
  /** Edits Nagent derived from its checks; used when the model's edit does not apply or does not fix the incident. */
  staticFixes: ProposedChange[];
  /** Root cause established by Nagent's history check, if any. */
  staticCause?: string;
  /** Diffs of the newest commit to each chosen file, shown to the model. */
  recentChanges: string[];
}

async function gatherFiles(id: string, incident: Incident, repo: RepoProvider, signal?: AbortSignal): Promise<Gathered> {
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
  const complete = quotedLineCount(quoted) * 10;
  const keywords = incidentKeywords(incident);
  const refs = referencedBlocks(incident);

  const scanned: Scanned[] = [];
  for (let i = 0; i < order.length; i += 6) {
    if (signal?.aborted) throw new CancelledError();
    const batch = (await Promise.all(order.slice(i, i + 6).map(read))).filter((f): f is RepoFile => f !== null);
    for (const f of batch) {
      scanned.push({ ...f, quotedScore: hasQuoted ? quotedCodeScore(f.content, quoted) : 0, ...contentRank(f, keywords, refs) });
    }
    // Quoted code decides: generic lines (`kind: Service`) match many files, so keep searching (other
    // folders too) until one file has all of them, exactly as quoted (commented out or not).
    if (quoted.lines.length) {
      if (scanned.some((s) => s.quotedScore >= complete)) break;
      continue;
    }
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
        ? `Quoted code from the report (${what}) found in: ${hits.slice(0, MAX_FILES_FOR_MODEL).map((h) => `${h.path}${h.quotedScore >= 10 ? ' (exact line)' : h.quotedScore >= 6 ? ' (same line, but commented out differently)' : ''}`).join(', ')}`
        : `Quoted code from the report (${what}) was not found in ${scanned.length} searched file(s)`,
    );
  }

  // Deterministic facts for the model: problems in the chosen files, and declarations that are missing.
  const findings = chosen.flatMap((f) => f.findings);
  const facts: Evidence[] = [];
  const undeclared: Array<{ kind: string; name: string }> = [];
  for (const { kind, name } of refs) {
    if (kind === 'resource' || kind === 'data') continue;
    const ref = `${kind === 'variable' ? 'var' : kind}.${name}`;
    if (scanned.some((s) => new RegExp(`^\\s*${kind}\\s+"${escapeRe(name)}"`, 'mi').test(s.content))) continue;
    const usedIn = scanned.filter((s) => new RegExp(`\\b${escapeRe(ref)}\\b`).test(s.content)).map((s) => s.path);
    const finding = `No ${kind} "${name}" is declared in the ${scanned.length} file(s) searched${usedIn.length ? `; it is referenced as ${ref} in ${usedIn.slice(0, 3).join(', ')}` : ''}`;
    findings.push(finding);
    undeclared.push({ kind, name });
    if (usedIn.length) facts.push({ type: 'fact', statement: `Nagent static check: ${finding}`, quote: ref, source: 'repository' });
  }
  const fixes = emptyNameFixes(chosen, undeclared);
  for (const f of fixes) {
    facts.push({ type: 'fact', statement: `Nagent static check: ${f.change.file} declares a block with an empty name`, quote: f.line, source: 'repository' });
  }
  const uncomments = uncommentFixes(chosen, incident);
  for (const u of uncomments) {
    const finding = `${u.change.file} line ${u.lineNo} has the quoted line commented out: ${u.line}`;
    findings.push(finding);
    facts.push({ type: 'fact', statement: `Nagent static check: ${finding}`, quote: u.line, source: 'repository' });
  }

  // What changed right before the incident, and whether a commit removed a line the error says is required.
  const history = new Map<string, FileRevision[]>();
  if (repo.fileHistory && chosen.length) {
    const results = await Promise.allSettled(chosen.map(async (f) => [f.path, await repo.fileHistory!(f.path, HISTORY_DEPTH)] as const));
    for (const r of results) if (r.status === 'fulfilled') history.set(...r.value);
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) addEvent(id, 'repo', `Could not read the commit history: ${failed.reason instanceof Error ? failed.reason.message : String(failed.reason)}`);
  }
  const recentChanges = chosen.flatMap((f) => {
    const r = history.get(f.path)?.[0];
    const text = r && recentChange(f.path, f.content, r);
    return text ? [text] : [];
  });
  const report = [incident.title, incident.description, incident.logs ?? ''].join('\n');
  const keys = [
    ...new Set([...requiredKeys(report), ...chosen.flatMap((f) => (/\.ya?ml$/i.test(f.path) ? k8sProblems(f.content).flatMap((p) => (p.missing ? [p.missing] : [])) : []))]),
  ];
  const restores = restoreFixes(chosen, history, keys);
  const causes: string[] = [];
  for (const r of restores) {
    const sha = r.revision.sha.slice(0, 7);
    const named = new RegExp(`\\b${sha}`).test(report) ? ', the revision named in the report' : '';
    const finding = `commit ${sha} ("${r.revision.message}"${named}) removed from ${r.change.file}: ${r.removed.join(' / ')}`;
    findings.unshift(`Repository history: ${finding}`);
    const quote = [...r.removed].sort((a, b) => b.length - a.length)[0];
    facts.push({ type: 'fact', statement: `Nagent history check: ${finding}`, quote, source: 'repository' });
    if (r.diff && !recentChanges.includes(r.diff)) recentChanges.push(r.diff);
    const content = chosen.find((f) => f.path === r.change.file)?.content ?? '';
    const rejected = k8sProblems(content);
    // Only claim the other errors go away when restoring the lines actually clears them.
    const cleared = rejected.length > 1 && !k8sProblems(content.replace(r.change.find, () => r.change.replace)).length;
    causes.push(
      `Commit ${sha} ("${r.revision.message}"${named}) removed ${r.removed.map((l) => `\`${l}\``).join(', ')} from ${r.change.file}` +
        (rejected.length
          ? `, so Kubernetes (and kustomize/Argo CD) reject the manifest: ${rejected[0].message}.` +
            (cleared ? ` Restoring these lines also clears the other ${rejected.length - 1} error(s) Nagent found in the file, which come from the same deletion.` : '')
          : '.'),
    );
  }
  if (restores.length) addEvent(id, 'repo', `History check: ${findings[0].replace(/^Repository history: /, '')}`);
  else if (recentChanges.length) addEvent(id, 'repo', `Newest commit(s) to the files: ${chosen.flatMap((f) => { const r = history.get(f.path)?.[0]; return r ? [`${f.path} ← ${r.sha.slice(0, 7)} "${r.message}"`] : []; }).join(', ')}`);
  if (findings.length) addEvent(id, 'repo', `Static checks: ${findings.slice(0, 3).join(' · ')}`);

  addEvent(
    id,
    'repo',
    chosen.length
      ? `Read ${chosen.length} relevant file(s) from ${repo.name}@${repo.baseBranch} (searched ${scanned.length} of ${candidates.length}): ${chosen.map((f) => f.path).join(', ')}`
      : `No relevant files found in ${repo.name} within the allowed paths (${repo.allowedPaths.join(', ') || 'none'}; searched ${scanned.length} of ${candidates.length} file(s))`,
  );
  return {
    files: chosen.map(({ path, content }) => ({ path, content })),
    findings: findings.slice(0, 10),
    facts,
    staticFixes: [...restores, ...fixes, ...uncomments].map((f) => f.change),
    staticCause: causes.length ? causes.join(' ') : undefined,
    recentChanges,
  };
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
  // An edit that applies but leaves the file broken (Kubernetes would still reject it) is not a fix either.
  const failing = failedChecks(first.changes, repo);
  if (!analysis.proposedChanges.length) return analysis;
  if (first.changes.length ? !failing.length : !fixable.length) return analysis;

  addEvent(
    id,
    'patch',
    first.changes.length
      ? `The model's change applies but does not fix the incident (${failing[0].file}: ${failing[0].detail.slice(0, 200)}) — asking it to fix the cause instead`
      : `The model's proposed change did not apply (${fixable[0].file}: ${fixable[0].reason}) — asking it to correct the edit`,
  );
  const feedback = [
    ...(first.changes.length
      ? [
          'Your proposedChanges apply, but the patched files would still be rejected:',
          ...failing.map((c) => `- ${c.file}: ${c.detail}`),
          'Fix the error that causes the others (a missing required field, often removed by the commit in recent_changes) instead of working around its symptoms.',
        ]
      : ['Your proposedChanges could not be applied to the repository:', ...fixable.map((r) => `- ${r.file}: ${r.reason}`)]),
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
    const stillFailing = failedChecks(second.changes, repo);
    if (stillFailing.length) {
      addEvent(id, 'patch', `Corrected edit still fails validation (${secs}s): ${stillFailing[0].file}: ${stillFailing[0].detail.slice(0, 200)}`);
      return analysis;
    }
    addEvent(id, 'patch', `Corrected edit applies to ${second.changes.map((c) => c.path).join(', ')} (${secs}s)`);
    return { ...analysis, proposedChanges: proposed };
  } catch (err) {
    if (err instanceof CancelledError) throw err;
    addEvent(id, 'patch', `Correcting the edit failed: ${err instanceof Error ? err.message : String(err)}`);
    return analysis;
  }
}

function failedChecks(changes: FileChange[], repo: RepoProvider): ValidationCheck[] {
  return validateChanges(changes, repo.allowedPaths).filter((c) => c.status === 'failed');
}

async function investigate(id: string, opts: { demo?: boolean; signal?: AbortSignal }): Promise<void> {
  const demo = Boolean(opts.demo || config.demoMode);
  const { signal } = opts;
  const checkpoint = () => {
    if (signal?.aborted) throw new CancelledError();
  };
  const incident = updateIncident(id, (i) => {
    i.status = 'investigating';
    i.error = undefined;
    i.analysis = undefined;
    i.remediation = undefined;
  });
  if (!incident) return;

  try {
    checkpoint();
    addEvent(id, 'analysis', demo ? 'Investigation started in DEMO MODE (no AI model)' : `Investigation started with Ollama model ${config.ollamaModel}`);

    const repo = getRepoProvider(incident.repoTarget);
    // Demo mode never sends repository contents anywhere and never proposes code changes.
    const { files, findings, facts, staticFixes, staticCause, recentChanges }: Gathered =
      repo && !demo ? await gatherFiles(id, incident, repo, signal) : { files: [], findings: [], facts: [], staticFixes: [], recentChanges: [] };
    if (!repo) addEvent(id, 'repo', `${repoLabel(incident)} not configured — analyzing the incident report only`);

    const analyzer = aiOverride ?? (demo ? demoAnalyzer : ollamaAnalyzer);
    if (analyzer === ollamaAnalyzer) {
      const status = await ollamaStatus();
      if (status.reachable && !status.modelAvailable) {
        addEvent(id, 'analysis', `Model ${config.ollamaModel} is not downloaded yet — downloading it now (several GB on first start)`);
      }
    }
    checkpoint();
    const started = Date.now();
    const modelFiles = files.map((f) => ({ path: f.path, content: truncateForModel(f.content) }));
    const { result, model, revise } = await analyzer({ incident, files: modelFiles, findings, recentChanges, signal });
    checkpoint();
    // Nagent's own facts are added before grounding: their quotes are checked like the model's.
    let analysis = groundEvidence({ ...result, evidence: [...facts, ...result.evidence] }, { incident, files, findings, recentChanges });
    if (repo && files.length) {
      const originals = new Map(files.map((f) => [f.path, f.content]));
      const modelChanges = applyProposedChanges(analysis.proposedChanges, originals, repo.allowedPaths).changes;
      const modelFailing = failedChecks(modelChanges, repo);
      const staticChanges = applyProposedChanges(staticFixes, originals, repo.allowedPaths).changes;
      const staticValid = staticChanges.length > 0 && !failedChecks(staticChanges, repo).length;
      // Small models often get the edit wrong, or patch a symptom (an edit that applies, but the file is still
      // rejected): an unambiguous, validated static fix is better than another slow model round.
      const wrongFix = modelChanges.length > 0 && modelFailing.length > 0 && staticValid;
      if (staticFixes.length && (!modelChanges.length || wrongFix)) {
        const fixes = staticFixes
          .map((c) => `${c.file}: ${c.find.includes('\n') ? c.description : `${c.find.trim()} → ${c.replace.trim()}`}`)
          .join('; ');
        addEvent(
          id,
          'patch',
          `${wrongFix ? `The model's change applies but does not fix the incident (${modelFailing[0].file}: ${modelFailing[0].detail.slice(0, 200)})` : analysis.proposedChanges.length ? "The model's proposed change did not apply" : 'The model proposed no change'} — using the fix from Nagent's ${staticCause ? 'history' : 'static'} check: ${fixes}`,
        );
        analysis = {
          ...analysis,
          proposedChanges: staticFixes,
          limitations: [...analysis.limitations, `The code change was derived by Nagent's ${staticCause ? 'repository-history' : 'static'} check, not written by the model.`],
        };
        if (staticCause) {
          // The cause is established from the code and its history, so it replaces the model's account.
          analysis = {
            ...analysis,
            probableRootCause: staticCause,
            recommendedFix: staticFixes.map((c) => c.description).join(' '),
            evidence: [
              ...analysis.evidence,
              {
                type: 'hypothesis',
                statement: `Model's root cause, not used${wrongFix ? ' (its patch left the file invalid)' : ''}: ${result.probableRootCause}`,
              },
            ],
            limitations: [...analysis.limitations, "The probable root cause above was established by Nagent's history check; the model's own explanation is listed under hypotheses."],
          };
        }
      } else if (revise) analysis = await reviseChanges(id, analysis, files, repo, revise);
    }
    checkpoint();

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
      addEvent(id, 'approval', 'Auto-approved (AUTO_CREATE_PR=true) — creating the PR without manual approval');
      // Failures are recorded on the remediation (pr_failed); the investigation itself succeeded.
      await createPullRequest(id).catch(() => undefined);
    }
  } catch (err) {
    if (err instanceof CancelledError || signal?.aborted) {
      updateIncident(id, (i) => {
        i.status = 'cancelled';
        i.error = undefined;
      });
      addEvent(id, 'info', 'Investigation stopped by the user');
      return;
    }
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
export async function approveAndCreatePr(id: string, actor?: string): Promise<Incident> {
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

  addEvent(id, 'approval', `Patch approved${by(actor)}`, actor);
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
