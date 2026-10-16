import { useCallback } from 'react';
import {
  Ban, Brain, ChevronRight, CircleCheck, Copy, ExternalLink, FlaskConical, GitPullRequest, Link2, RotateCcw, Square, Trash2, UserRound,
} from 'lucide-react';
import type { MenuEntry } from './menu';
import { api, type Incident, type IncidentSummary } from '@/lib/api';
import { useData, stoppable } from '@/lib/data';
import { copyText } from '@/lib/format';
import { useConfirm, usePrompt, useToast } from './feedback';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Every incident action with its confirmation, toast and data refresh, so the table, drawer, detail
 * page and approval queue behave the same. Each returns the updated incident (or null when cancelled/failed).
 */
export function useIncidentActions() {
  const toast = useToast();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const { refresh, refreshAudit, incidents, operator } = useData();

  const settle = useCallback(() => void Promise.all([refresh(), refreshAudit()]), [refresh, refreshAudit]);

  const run = useCallback(
    async <T,>(fn: () => Promise<T>, success: string | undefined, failure: string): Promise<T | null> => {
      try {
        const result = await fn();
        if (success) toast({ tone: 'success', title: success });
        return result;
      } catch (err) {
        toast({ tone: 'error', title: failure, description: message(err) });
        return null;
      } finally {
        settle();
      }
    },
    [toast, settle],
  );

  const investigate = (id: string, mode: 'ai' | 'demo' = 'ai') =>
    run(() => api.investigate(id, mode).then((d) => d.incident), mode === 'ai' ? 'Investigation started' : 'Demo analysis started', 'Could not start the investigation');

  const stop = async (ids: string[]): Promise<Incident | null> => {
    const results = await Promise.allSettled(ids.map((id) => api.cancel(id)));
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    const done = ids.length - failed.length;
    if (done) toast({ tone: 'success', title: ids.length === 1 ? 'Investigation stopped' : `Stopped ${plural(done, 'investigation')}` });
    if (failed.length) toast({ tone: 'error', title: `${plural(failed.length, 'investigation')} could not be stopped`, description: message(failed[0].reason) });
    settle();
    const first = results[0];
    return first?.status === 'fulfilled' ? first.value.incident : null;
  };

  const approve = async (id: string): Promise<Incident | null> => {
    let incident: Incident;
    try {
      incident = (await api.get(id)).incident;
    } catch (err) {
      toast({ tone: 'error', title: 'Could not load the patch', description: message(err) });
      return null;
    }
    const r = incident.remediation;
    if (!r) return null;
    const gitlab = r.provider === 'gitlab';
    const noun = gitlab ? 'merge request' : 'pull request';
    const short = gitlab ? 'MR' : 'PR';
    const codeChanges = r.changes.filter((c) => !c.path.startsWith('docs/incidents/')).length;
    const ok = await confirm({
      title: `Create ${noun}?`,
      confirmLabel: `Approve & create ${short}`,
      body: (
        <>
          <p>
            {r.provider === 'mock' ? (
              'Target: the MOCK repository (no real PR).'
            ) : (
              <>
                A real branch and {noun} will be opened on {gitlab ? 'GitLab' : 'GitHub'} <span className="font-mono text-fg">{r.repo}</span> against{' '}
                <span className="font-mono text-fg">{r.baseBranch}</span>.
              </>
            )}
          </p>
          <p className={codeChanges ? '' : 'text-amber-200'}>
            {codeChanges ? `It changes ${plural(codeChanges, 'file')} plus the RCA document.` : `It contains NO code change — only the RCA document (draft ${short}).`}
          </p>
          {operator && <p className="text-fg-muted">Recorded as approved by {operator}.</p>}
        </>
      ),
    });
    if (!ok) return null;
    return run(() => api.approve(id).then((d) => d.incident), `${short} created`, `${short} creation failed`);
  };

  const reject = async (id: string): Promise<Incident | null> => {
    const reason = await prompt({
      title: `Reject the patch for ${id}?`,
      body: <p>No pull request is opened. The incident stays open — re-run the investigation for a new proposal.</p>,
      label: 'Reason (recorded in the audit log)',
      placeholder: 'e.g. Wrong file — the version constraint lives in versions.tf',
      multiline: true,
      tone: 'danger',
      confirmLabel: 'Reject patch',
    });
    if (reason === null) return null;
    return run(() => api.reject(id, reason || undefined).then((d) => d.incident), 'Patch rejected', 'Could not reject the patch');
  };

  const resolve = async (id: string): Promise<Incident | null> => {
    const note = await prompt({
      title: `Resolve ${id}?`,
      body: <p>Mark the incident as fixed — for example after the pull request was merged and deployed.</p>,
      label: 'Resolution note (optional)',
      placeholder: 'e.g. PR #42 merged, Argo CD synced, pods healthy',
      multiline: true,
      confirmLabel: 'Resolve incident',
    });
    if (note === null) return null;
    return run(() => api.resolve(id, note || undefined).then((d) => d.incident), `${id} resolved`, 'Could not resolve the incident');
  };

  const reopen = (id: string) => run(() => api.reopen(id).then((d) => d.incident), `${id} reopened`, 'Could not reopen the incident');

  const assign = async (id: string, current?: string): Promise<Incident | null> => {
    const known = [...new Set([operator, ...(incidents ?? []).map((i) => i.owner ?? '')].filter(Boolean))].slice(0, 6);
    const owner = await prompt({
      title: `Assign ${id}`,
      label: 'Owner (leave empty to unassign)',
      placeholder: 'Name',
      initial: current ?? '',
      suggestions: known,
      confirmLabel: 'Assign',
    });
    if (owner === null) return null;
    return run(() => api.assign(id, owner || null).then((d) => d.incident), owner ? `Assigned to ${owner}` : 'Unassigned', 'Could not assign the incident');
  };

  const remove = async (ids: string[]): Promise<boolean> => {
    const list = (incidents ?? []).filter((i) => ids.includes(i.id));
    const running = list.filter(stoppable).length;
    const withPr = list.filter((i) => i.prUrl).length;
    const ok = await confirm({
      tone: 'danger',
      title: ids.length === 1 ? `Delete ${ids[0]}?` : `Delete ${ids.length} incidents?`,
      confirmLabel: ids.length === 1 ? 'Delete incident' : `Delete ${ids.length} incidents`,
      body: (
        <>
          <p>The incident{ids.length === 1 ? '' : 's'} and RCA will be removed. The timeline stays in the audit log.</p>
          {running > 0 && <p className="text-amber-200">{plural(running, 'running investigation')} {running === 1 ? 'is' : 'are'} stopped first.</p>}
          {withPr > 0 && <p className="text-fg-muted">Pull requests already opened stay on GitHub/GitLab.</p>}
        </>
      ),
    });
    if (!ok) return false;
    const results = await Promise.allSettled(ids.map((id) => api.remove(id)));
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    const done = ids.length - failed.length;
    if (done) toast({ tone: 'success', title: ids.length === 1 ? `${ids[0]} deleted` : `${plural(done, 'incident')} deleted` });
    if (failed.length) toast({ tone: 'error', title: `${failed.length} could not be deleted`, description: message(failed[0].reason) });
    settle();
    return done > 0;
  };

  const copy = async (text: string, what: string) => {
    try {
      await copyText(text);
      toast({ tone: 'success', title: `${what} copied` });
    } catch (err) {
      toast({ tone: 'error', title: 'Copy failed', description: message(err) });
    }
  };

  return { investigate, stop, approve, reject, resolve, reopen, assign, remove, copy };
}

export type IncidentActions = ReturnType<typeof useIncidentActions>;

/** The ⋯ menu entries for one incident, shared by the table, overview and approval queue. */
export function incidentMenuItems(
  i: IncidentSummary,
  actions: IncidentActions,
  open: () => void,
): Array<MenuEntry | false> {
  const canStop = stoppable(i);
  const busy = i.running;
  const canRun = !busy && !['pr_created', 'creating_pr', 'resolved'].includes(i.status);
  const canApprove = !busy && (i.remediationStatus === 'awaiting_approval' || i.remediationStatus === 'pr_failed');
  const canReject = !busy && Boolean(i.remediationStatus) && !['pr_created', 'rejected', 'creating_pr'].includes(i.remediationStatus!);
  const rerun = Boolean(i.analysisMode) || ['failed', 'cancelled', 'rejected'].includes(i.status);
  const link = `${window.location.origin}${window.location.pathname}#/incidents/${i.id}`;
  return [
    { label: 'Open incident', icon: ChevronRight, onSelect: open },
    !!i.prUrl && /^https:\/\//.test(i.prUrl) && { label: 'View pull request', icon: ExternalLink, onSelect: () => void window.open(i.prUrl, '_blank', 'noopener') },
    'separator',
    canStop && { label: 'Stop analysis', icon: Square, description: 'Abort the running model request', onSelect: () => void actions.stop([i.id]) },
    canRun && { label: rerun ? 'Re-run AI investigation' : 'Run AI investigation', icon: Brain, onSelect: () => void actions.investigate(i.id, 'ai') },
    canRun && { label: 'Run demo analysis', icon: FlaskConical, description: 'Keyword heuristic, no AI', onSelect: () => void actions.investigate(i.id, 'demo') },
    canApprove && { label: 'Approve & create PR', icon: GitPullRequest, onSelect: () => void actions.approve(i.id) },
    canReject && { label: 'Reject patch', icon: Ban, onSelect: () => void actions.reject(i.id) },
    'separator',
    { label: i.owner ? `Reassign (${i.owner})` : 'Assign owner', icon: UserRound, onSelect: () => void actions.assign(i.id, i.owner) },
    i.status === 'resolved'
      ? { label: 'Reopen', icon: RotateCcw, onSelect: () => void actions.reopen(i.id) }
      : !busy && { label: 'Mark resolved', icon: CircleCheck, onSelect: () => void actions.resolve(i.id) },
    { label: 'Copy incident ID', icon: Copy, onSelect: () => void actions.copy(i.id, 'Incident ID') },
    { label: 'Copy link', icon: Link2, onSelect: () => void actions.copy(link, 'Link') },
    'separator',
    { label: 'Delete incident', icon: Trash2, danger: true, onSelect: () => void actions.remove([i.id]) },
  ];
}
