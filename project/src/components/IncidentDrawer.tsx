import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  Ban, Check, Copy, ExternalLink, GitPullRequest, Loader2, Maximize2, MoreHorizontal, Play, RotateCcw, Square, UserRound, X,
} from 'lucide-react';
import { api, type Incident, type IncidentSummary } from '@/lib/api';
import { shortRepo } from '@/lib/data';
import { timeAgo } from '@/lib/format';
import { repositories, useHealth } from '@/lib/health';
import { incidentMenuItems, useIncidentActions } from './actions';
import { DiffView, diffStats } from './Diff';
import { ServiceIcon } from './layout';
import { Menu } from './menu';
import { Avatar, Dot, ErrorBox, RepoIcon, SeverityBadge, Spinner, StatusBadge } from './ui';

export function toSummary(i: Incident, running: boolean): IncidentSummary {
  return {
    id: i.id,
    title: i.title,
    severity: i.severity,
    status: i.status,
    service: i.service,
    environment: i.environment,
    source: i.source,
    occurrences: i.occurrences,
    repoTarget: i.repoTarget,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
    analysisMode: i.analysis?.mode,
    confidence: i.analysis?.result.confidence,
    remediationStatus: i.remediation?.status,
    prUrl: i.remediation?.pr?.url,
    owner: i.owner,
    resolvedAt: i.resolvedAt,
    snippet: '',
    running,
  };
}

type StepState = 'done' | 'active' | 'waiting' | 'failed' | 'pending';
interface Step {
  label: string;
  detail: string;
  at?: string;
  state: StepState;
}

/** Condensed progress for the side panel, derived from the incident's timeline and results. */
export function incidentSteps(i: Incident, running: boolean): Step[] {
  const a = i.analysis;
  const r = i.remediation;
  const repoEvent = i.timeline.find((e) => e.type === 'repo');
  const patchEvent = [...i.timeline].reverse().find((e) => e.type === 'patch' && /^Patch prepared/.test(e.message));
  const analyzing = i.status === 'investigating' && running;
  const codeFiles = r?.changes.filter((c) => !c.path.startsWith('docs/incidents/')) ?? [];
  const last = (re: RegExp) => [...i.timeline].reverse().find((e) => re.test(e.message))?.at;

  const steps: Step[] = [
    { label: 'Incident detected', detail: `Received from ${i.source}${i.occurrences > 1 ? ` · ${i.occurrences} occurrences` : ''}`, at: i.createdAt, state: 'done' },
    {
      label: 'Evidence collected',
      detail: repoEvent ? repoEvent.message.replace(/\s*\(searched.*$/, '').slice(0, 90) : a ? 'Incident report only' : analyzing ? 'Reading the repository…' : 'Not started',
      at: repoEvent?.at,
      state: repoEvent || a ? 'done' : analyzing ? 'active' : 'pending',
    },
    {
      label: 'RCA generated',
      detail: a ? `${a.mode === 'demo' ? 'Demo heuristic' : a.model ?? 'AI'} · confidence ${a.result.confidence}%` : analyzing ? 'Model is analyzing…' : i.status === 'failed' ? 'Investigation failed' : i.status === 'cancelled' ? 'Stopped by the user' : 'Not started',
      at: a?.generatedAt,
      state: a ? 'done' : analyzing && repoEvent ? 'active' : i.status === 'failed' || i.status === 'cancelled' ? 'failed' : 'pending',
    },
    {
      label: 'Proposed patch',
      detail: r ? (codeFiles.length ? `${codeFiles.length} file(s): ${codeFiles.map((c) => c.path.split('/').pop()).join(', ')}` : 'RCA document only — no code change') : 'Not started',
      at: patchEvent?.at,
      state: r ? (r.checks.some((c) => c.status === 'failed') ? 'failed' : 'done') : 'pending',
    },
  ];

  const final: Step =
    i.status === 'resolved'
      ? { label: 'Resolved', detail: 'Closed by an operator', at: i.resolvedAt, state: 'done' }
      : r?.pr
        ? { label: r.provider === 'gitlab' ? `MR !${r.pr.number} created` : `PR #${r.pr.number} created`, detail: r.pr.draft ? 'Draft · RCA only' : 'Ready for review', at: last(/(PR #|MR !)\d+ created/), state: 'done' }
        : i.status === 'creating_pr'
          ? { label: 'Creating pull request', detail: 'Branch, commit and PR…', state: 'active' }
          : r?.status === 'rejected'
            ? { label: 'Patch rejected', detail: r.message?.replace(/ Re-run.*$/, '') ?? 'Rejected by a reviewer', at: last(/^Patch rejected/), state: 'failed' }
            : r?.status === 'awaiting_approval' || r?.status === 'pr_failed'
              ? { label: 'Waiting for approval', detail: r.status === 'pr_failed' ? 'Last PR attempt failed — approve to retry' : 'Human review required to create PR', state: 'waiting' }
              : r
                ? { label: 'No PR possible', detail: r.message ?? r.status, state: 'failed' }
                : { label: 'Approval', detail: 'After the patch is ready', state: 'pending' };
  return [...steps, final];
}

const STEP_ICON: Record<StepState, string> = {
  done: 'bg-emerald-500 text-white',
  active: 'bg-sky-500/20 text-sky-200 ring-1 ring-sky-400/60',
  waiting: 'bg-amber-500 text-black',
  failed: 'bg-rose-500/20 text-rose-200 ring-1 ring-rose-500/60',
  pending: 'bg-panel-3 text-fg-muted ring-1 ring-edge',
};

export function StepList({ steps }: { steps: Step[] }) {
  return (
    <ol className="space-y-0">
      {steps.map((s, k) => (
        <li key={k} className="relative flex gap-3 pb-4 last:pb-0">
          {k < steps.length - 1 && <span className={`absolute left-[11px] top-6 h-[calc(100%-20px)] w-px ${s.state === 'done' ? 'bg-emerald-500/50' : 'bg-edge-strong'}`} />}
          <span className={`relative z-10 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full ${STEP_ICON[s.state]}`}>
            {s.state === 'done' ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : s.state === 'active' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : s.state === 'failed' ? <X className="h-3.5 w-3.5" /> : s.state === 'waiting' ? <UserRound className="h-3.5 w-3.5" /> : <span className="h-1.5 w-1.5 rounded-full bg-current" />}
          </span>
          <div className="min-w-0 flex-1">
            <p className={`flex justify-between gap-2 text-sm font-medium ${s.state === 'waiting' ? 'text-amber-200' : s.state === 'pending' ? 'text-fg-muted' : 'text-fg'}`}>
              {s.label}
              {s.at && <span className="flex-shrink-0 text-[11px] font-normal text-fg-muted">{timeAgo(s.at)}</span>}
            </p>
            <p className="break-words text-xs text-fg-muted">{s.detail}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

type Tab = 'logs' | 'rca' | 'diff';

/** Side panel for one incident: progress, evidence, proposed change and review actions. */
export function IncidentDrawer({ id, onClose, navigate }: { id: string; onClose: () => void; navigate: (hash: string) => void }) {
  const [incident, setIncident] = useState<Incident | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('logs');
  const [acting, setActing] = useState<string | null>(null);
  const actions = useIncidentActions();
  const { health } = useHealth();
  const repos = repositories(health);

  const load = useCallback(async () => {
    try {
      const d = await api.get(id);
      setIncident(d.incident);
      setRunning(d.running);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [id]);

  useEffect(() => {
    setIncident(null);
    void load();
  }, [load]);

  useEffect(() => {
    const t = setInterval(load, running ? 3000 : 10000);
    return () => clearInterval(t);
  }, [load, running]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('[aria-modal="true"]') && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const act = async (name: string, fn: () => Promise<unknown>) => {
    setActing(name);
    try {
      await fn();
      await load();
    } finally {
      setActing(null);
    }
  };

  const shell = (body: ReactNode) => (
    <aside
      aria-label="Incident details"
      className="fixed bottom-0 right-0 top-16 z-40 flex w-full max-w-[440px] animate-fade-up flex-col border-l border-edge-strong bg-panel shadow-2xl shadow-black/60 min-[1800px]:sticky min-[1800px]:top-20 min-[1800px]:z-auto min-[1800px]:h-[calc(100vh-6rem)] min-[1800px]:max-w-none min-[1800px]:rounded-xl min-[1800px]:border min-[1800px]:shadow-panel"
    >
      {body}
    </aside>
  );

  if (!incident) {
    return shell(
      <div className="p-5">
        <div className="flex justify-end">
          <button onClick={onClose} className="btn-icon" aria-label="Close panel">
            <X className="h-4 w-4" />
          </button>
        </div>
        {error ? <ErrorBox message={error} onRetry={() => void load()} /> : <Spinner label="Loading incident…" />}
      </div>,
    );
  }

  const i = incident;
  const r = i.remediation;
  const a = i.analysis;
  const summary = toSummary(i, running);
  const repo = repos.find((x) => x.id === i.repoTarget);
  const analyzing = running && i.status !== 'creating_pr';
  const canApprove = !running && (r?.status === 'awaiting_approval' || r?.status === 'pr_failed');
  const canReject = !running && r && !['pr_created', 'rejected', 'creating_pr'].includes(r.status);
  const canRun = !running && !['pr_created', 'creating_pr', 'resolved'].includes(i.status);
  const short = r?.provider === 'gitlab' ? 'MR' : 'PR';
  const code = r?.changes.filter((c) => !c.path.startsWith('docs/incidents/')) ?? [];
  const firstChange = code[0] ?? r?.changes[0];
  const logLines = (i.logs || i.description || '').split('\n').slice(0, 200);

  return shell(
    <>
      <div className="scrollbar-thin flex-1 overflow-y-auto">
        <div className="border-b border-edge p-5">
          <div className="mb-3 flex items-center gap-2">
            <SeverityBadge severity={i.severity} />
            <StatusBadge status={i.status} />
            <span className="flex-1" />
            <Menu
              ariaLabel="More actions"
              buttonClassName="btn-icon"
              panelClassName="w-60"
              button={<MoreHorizontal className="h-4 w-4" />}
              items={incidentMenuItems(summary, actions, () => navigate(`#/incidents/${i.id}`))}
            />
            <button onClick={onClose} className="btn-icon" aria-label="Close panel" title="Close (Esc)">
              <X className="h-4 w-4" />
            </button>
          </div>
          <h2 className="break-words font-display text-lg font-semibold leading-snug text-fg">{i.title}</h2>
          {i.description && i.description !== i.title && <p className="mt-1 line-clamp-3 break-words text-sm text-fg-soft">{i.description}</p>}
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-fg-soft">
            <span className="font-mono text-fg-muted">#{i.id}</span>
            {i.service && (
              <span className="flex items-center gap-1.5">
                <ServiceIcon name={i.service} className="h-3.5 w-3.5" /> {i.service}
              </span>
            )}
            {repo && (
              <span className="flex items-center gap-1.5" title={repo.name}>
                <RepoIcon provider={repo.provider} className="h-3.5 w-3.5" /> {shortRepo(repo.name)}
              </span>
            )}
            {i.environment && (
              <span className="flex items-center gap-1.5">
                <Dot tone={/prod/i.test(i.environment) ? 'ok' : 'warn'} /> {i.environment}
              </span>
            )}
          </div>
          <button onClick={() => void actions.assign(i.id, i.owner).then(load)} className="mt-3 flex items-center gap-2 rounded-lg text-xs text-fg-soft hover:text-fg">
            {i.owner ? <Avatar name={i.owner} size="h-6 w-6 text-[9px]" /> : <UserRound className="h-4 w-4 text-fg-muted" />}
            {i.owner ? `Owner: ${i.owner}` : 'Unassigned — assign owner'}
          </button>
        </div>

        <section className="border-b border-edge p-5">
          <h3 className="mb-3 text-sm font-semibold text-fg">Timeline</h3>
          <StepList steps={incidentSteps(i, running)} />
        </section>

        <section className="border-b border-edge p-5">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-fg">Evidence</h3>
            <a href={`#/incidents/${i.id}`} className="text-xs text-violet-300 hover:underline">
              View all
            </a>
          </div>
          <div className="mb-3 flex gap-1" role="tablist">
            {(
              [
                ['logs', 'Logs'],
                ['rca', 'Root cause'],
                ['diff', 'Diff'],
              ] as Array<[Tab, string]>
            ).map(([t, label]) => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${tab === t ? 'bg-violet-500/25 text-fg ring-1 ring-violet-500/40' : 'text-fg-muted hover:text-fg'}`}
              >
                {label}
              </button>
            ))}
          </div>
          {tab === 'logs' && (
            <div className="relative rounded-lg border border-edge bg-black/40">
              <button
                onClick={() => void actions.copy(i.logs || i.description, 'Logs')}
                className="btn-icon absolute right-1.5 top-1.5 h-7 w-7"
                aria-label="Copy logs"
                title="Copy"
              >
                <Copy className="h-3.5 w-3.5" />
              </button>
              <pre className="scrollbar-thin max-h-56 overflow-auto py-2 font-mono text-[11px] leading-5">
                {logLines.map((l, k) => (
                  <div key={k} className={`flex pr-10 ${/error|fail|fatal|denied|not found|invalid/i.test(l) ? 'text-rose-300' : 'text-fg-soft'}`}>
                    <span className="w-9 flex-shrink-0 select-none pr-3 text-right text-fg-muted/60">{k + 1}</span>
                    <span className="whitespace-pre-wrap break-all">{l || ' '}</span>
                  </div>
                ))}
                {!logLines.join('').trim() && <div className="px-3 text-fg-muted">No logs were attached.</div>}
              </pre>
            </div>
          )}
          {tab === 'rca' &&
            (a ? (
              <div className="space-y-3 text-sm">
                <p className="text-fg">{a.result.probableRootCause}</p>
                {a.result.evidence.filter((e) => e.type === 'fact').slice(0, 3).map((f, k) => (
                  <div key={k} className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-2.5 text-xs text-fg-soft">
                    {f.statement}
                    {f.quote && <code className="mt-1 block break-words font-mono text-[11px] text-fg">{f.quote}</code>}
                  </div>
                ))}
                <p className="text-xs text-fg-muted">Recommended fix: {a.result.recommendedFix || '—'}</p>
              </div>
            ) : (
              <p className="text-sm text-fg-muted">{analyzing ? 'The model is still analyzing…' : 'No analysis yet.'}</p>
            ))}
          {tab === 'diff' &&
            (r?.changes.length ? (
              <ul className="divide-y divide-edge rounded-lg border border-edge text-xs">
                {r.changes.map((c) => {
                  const st = diffStats(c.diff);
                  return (
                    <li key={c.path} className="flex items-center gap-2 px-3 py-2">
                      <span className="min-w-0 flex-1 truncate font-mono text-fg-soft" title={c.path}>{c.path}</span>
                      <span className="font-mono text-emerald-400">+{st.added}</span>
                      <span className="font-mono text-rose-400">−{st.removed}</span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-sm text-fg-muted">No patch yet.</p>
            ))}
        </section>

        {firstChange && (
          <section className="p-5">
            <h3 className="mb-3 text-sm font-semibold text-fg">Proposed changes</h3>
            <div className="overflow-hidden rounded-lg border border-edge">
              <div className="flex items-center gap-2 bg-panel-2/70 px-3 py-2">
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg" title={firstChange.path}>{firstChange.path.split('/').pop()}</span>
                <span className="font-mono text-[11px]">
                  <span className="text-emerald-400">+{diffStats(firstChange.diff).added}</span> <span className="text-rose-400">−{diffStats(firstChange.diff).removed}</span>
                </span>
                <button onClick={() => void actions.copy(firstChange.diff, 'Diff')} className="btn-icon h-6 w-6" aria-label="Copy diff" title="Copy diff">
                  <Copy className="h-3.5 w-3.5" />
                </button>
              </div>
              <DiffView diff={firstChange.diff} className="max-h-60 border-t border-edge" />
            </div>
            {r && r.changes.length > 1 && <p className="mt-2 text-xs text-fg-muted">+ {r.changes.length - 1} more file(s) — open the full review to see all.</p>}
          </section>
        )}
      </div>

      <div className="space-y-2 border-t border-edge bg-panel-2/60 p-4">
        {analyzing && (
          <button onClick={() => void act('stop', () => actions.stop([i.id]))} disabled={acting !== null} className="btn-danger w-full">
            {acting === 'stop' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-3.5 w-3.5 fill-current" />} Stop analysis
          </button>
        )}
        {(canApprove || canReject) && (
          <div className="grid grid-cols-2 gap-2">
            <button onClick={() => void act('reject', () => actions.reject(i.id))} disabled={acting !== null || !canReject} className="btn-danger">
              {acting === 'reject' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ban className="h-4 w-4" />} Reject
            </button>
            <button onClick={() => void act('approve', () => actions.approve(i.id))} disabled={acting !== null || !canApprove} className="btn-primary">
              {acting === 'approve' ? <Loader2 className="h-4 w-4 animate-spin" /> : <GitPullRequest className="h-4 w-4" />} Approve & create {short}
            </button>
          </div>
        )}
        {canRun && !canApprove && (
          <button onClick={() => void act('run', () => actions.investigate(i.id, 'ai'))} disabled={acting !== null} className="btn-secondary w-full">
            {acting === 'run' ? <Loader2 className="h-4 w-4 animate-spin" /> : a || i.status !== 'open' ? <RotateCcw className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            {a || i.status !== 'open' ? 'Re-run investigation' : 'Investigate'}
          </button>
        )}
        {r?.pr && /^https:\/\//.test(r.pr.url) && !r.pr.mock && (
          <a href={r.pr.url} target="_blank" rel="noopener noreferrer" className="btn-secondary w-full">
            <GitPullRequest className="h-4 w-4 text-emerald-300" /> View {short} #{r.pr.number} <ExternalLink className="h-3.5 w-3.5 text-fg-muted" />
          </a>
        )}
        <a href={`#/incidents/${i.id}`} className="btn-secondary w-full">
          <Maximize2 className="h-4 w-4" /> Open full review
        </a>
      </div>
    </>,
  );
}
