import { useCallback, useEffect, useState } from 'react';
import {
  ArrowLeft, Ban, Bell, Brain, Check, CheckCircle2, ChevronDown, CircleCheck, Clock, Copy, Download, ExternalLink, FileCode2, FileDiff,
  FlaskConical, GitPullRequest, Link2, Loader2, MinusCircle, MoreHorizontal, Play, RotateCcw, ShieldCheck, Sparkles, Square, Trash2,
  UserCheck, UserRound, X, XCircle,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api, type Incident } from '@/lib/api';
import { downloadFile, duration, timeAgo } from '@/lib/format';
import { useHealth } from '@/lib/health';
import { useIncidentActions } from './actions';
import { FileDiffBlock } from './Diff';
import { useToast } from './feedback';
import { Menu } from './menu';
import { Avatar, Card, ErrorBox, SeverityBadge, Spinner, StatusBadge } from './ui';

const BUSY = ['investigating', 'creating_pr'];

/** Re-renders every `ms` while `on`, for live elapsed-time counters. */
function useNow(on: boolean, ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [on, ms]);
  return now;
}

export function IncidentDetail({ id, navigate }: { id: string; navigate: (hash: string) => void }) {
  const [incident, setIncident] = useState<Incident | null>(null);
  const [running, setRunning] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const toast = useToast();
  const actions = useIncidentActions();
  const { health } = useHealth();

  const load = useCallback(async () => {
    try {
      const data = await api.get(id);
      setIncident(data.incident);
      setRunning(data.running);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [id]);

  const busy = running || (incident ? BUSY.includes(incident.status) : false);
  const analyzing = running && incident?.status !== 'creating_pr';
  const now = useNow(analyzing);

  useEffect(() => {
    void load();
    const t = setInterval(load, busy ? 2000 : 10000);
    return () => clearInterval(t);
  }, [load, busy]);

  const act = async (name: string, fn: () => Promise<{ incident: Incident }>, done?: string) => {
    setActing(name);
    setActionError(null);
    try {
      const { incident: updated } = await fn();
      setIncident(updated);
      if (done) toast({ tone: 'success', title: done });
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
      await load();
    } finally {
      setActing(null);
    }
  };

  /** Runs a shared action (it handles confirmation and toasts), then reloads this page. */
  const run = async (name: string, fn: () => Promise<unknown>) => {
    setActing(name);
    setActionError(null);
    try {
      await fn();
    } finally {
      await load();
      setActing(null);
    }
  };

  const stop = () => void act('stop', () => api.cancel(id), 'Investigation stopped');

  const remove = async () => {
    setActing('delete');
    if (await actions.remove([id])) navigate('#/incidents');
    else setActing(null);
  };

  if (loadError && !incident) {
    return (
      <div className="space-y-4">
        <BackLink />
        <ErrorBox message={loadError} onRetry={() => void load()} />
      </div>
    );
  }
  if (!incident) return <Spinner label="Loading incident…" />;

  const a = incident.analysis;
  const r = incident.remediation;
  const canApprove = r && (r.status === 'awaiting_approval' || r.status === 'pr_failed') && !busy;
  const canReject = !busy && r && !['pr_created', 'rejected', 'creating_pr'].includes(r.status);
  const canRetry = !busy && incident.status !== 'pr_created' && incident.status !== 'resolved';
  const gitlab = r?.provider === 'gitlab';
  const requestShort = gitlab ? 'MR' : 'PR';

  const rerun = Boolean(a) || ['failed', 'cancelled', 'rejected'].includes(incident.status);
  const model = health?.ai.demoMode ? 'demo heuristic' : health?.ai.model;
  const startedAt = [...incident.timeline].reverse().find((e) => e.type === 'analysis' && /^Investigation started/.test(e.message))?.at;
  const link = `${window.location.origin}${window.location.pathname}#/incidents/${incident.id}`;

  return (
    <div className="space-y-6">
      <BackLink />

      <section className="relative animate-fade-up overflow-hidden rounded-2xl border border-edge bg-panel/80 p-6 shadow-panel backdrop-blur">
        <div aria-hidden="true" className="absolute -right-24 -top-24 h-64 w-64 rounded-full bg-violet-600/20 blur-3xl" />
        <div className="relative flex flex-wrap items-start justify-between gap-5">
          <div className="min-w-0 flex-1">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="rounded-md bg-panel-3 px-2 py-0.5 font-mono text-[11px] text-fg-soft ring-1 ring-edge">{incident.id}</span>
              <SeverityBadge severity={incident.severity} />
              <StatusBadge status={incident.status} />
            </div>
            <h1 className="break-words font-display text-2xl font-bold tracking-tight text-fg sm:text-3xl">{incident.title}</h1>
            <p className="mt-2 text-sm text-fg-muted">
              {[incident.service, incident.environment, `via ${incident.source}`].filter(Boolean).join(' · ')} · reported {timeAgo(incident.createdAt)}
              {incident.occurrences > 1 && ` · ${incident.occurrences} occurrences`}
            </p>
            <button onClick={() => void run('assign', () => actions.assign(id, incident.owner))} className="mt-2 inline-flex items-center gap-2 text-sm text-fg-soft hover:text-fg">
              {incident.owner ? <Avatar name={incident.owner} size="h-6 w-6 text-[9px]" /> : <UserRound className="h-4 w-4 text-fg-muted" />}
              {incident.owner ? `Owner: ${incident.owner}` : 'Unassigned — assign an owner'}
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {analyzing ? (
              <button disabled={acting !== null} onClick={stop} className="btn-danger">
                {acting === 'stop' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-3.5 w-3.5 fill-current" />}
                Stop analysis
              </button>
            ) : (
              <div className="inline-flex">
                <button
                  disabled={!canRetry || acting !== null}
                  onClick={() => void act('ai', () => api.investigate(id, 'ai'), 'Investigation started')}
                  className="btn-secondary rounded-r-none border-r-0"
                  title={
                    incident.status === 'pr_created' ? 'A PR was already created for this incident' : incident.status === 'resolved' ? 'Reopen the incident first' : model ? `Analyze with ${model}` : undefined
                  }
                >
                  {acting === 'ai' || acting === 'demo' ? <Loader2 className="h-4 w-4 animate-spin" /> : rerun ? <RotateCcw className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                  {rerun ? 'Re-run investigation' : 'Investigate'}
                </button>
                <Menu
                  ariaLabel="Investigation options"
                  disabled={!canRetry || acting !== null}
                  buttonClassName="btn-secondary rounded-l-none px-2.5"
                  panelClassName="w-72"
                  button={<ChevronDown className="h-4 w-4" />}
                  items={[
                    { heading: 'Run investigation' },
                    {
                      label: 'AI investigation',
                      icon: Brain,
                      description: model ? `Ollama · ${model} — reads the repository and proposes a patch` : 'Reads the repository and proposes a patch',
                      onSelect: () => void act('ai', () => api.investigate(id, 'ai'), 'Investigation started'),
                    },
                    {
                      label: 'Demo analysis',
                      icon: FlaskConical,
                      description: 'Keyword heuristic, no AI model — cannot open real PRs',
                      onSelect: () => void act('demo', () => api.investigate(id, 'demo'), 'Demo analysis started'),
                    },
                  ]}
                />
              </div>
            )}
            {canReject && (
              <button disabled={acting !== null} onClick={() => void run('reject', () => actions.reject(id))} className="btn-danger">
                {acting === 'reject' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ban className="h-4 w-4" />}
                Reject
              </button>
            )}
            {canApprove && (
              <button disabled={acting !== null} onClick={() => void run('approve', () => actions.approve(id))} className="btn-primary">
                {acting === 'approve' ? <Loader2 className="h-4 w-4 animate-spin" /> : <GitPullRequest className="h-4 w-4" />}
                Approve & create {requestShort}
              </button>
            )}
            {r?.pr && /^https:\/\//.test(r.pr.url) && !r.pr.mock && (
              <a href={r.pr.url} target="_blank" rel="noopener noreferrer" className="btn-secondary">
                <GitPullRequest className="h-4 w-4 text-emerald-300" /> View {requestShort} <ExternalLink className="h-3.5 w-3.5 text-fg-muted" />
              </a>
            )}
            <Menu
              ariaLabel="More actions"
              title="More actions"
              buttonClassName="btn-secondary px-2.5"
              panelClassName="w-60"
              disabled={acting === 'delete'}
              button={acting === 'delete' ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoreHorizontal className="h-4 w-4" />}
              items={[
                { label: incident.owner ? `Reassign (${incident.owner})` : 'Assign owner', icon: UserRound, onSelect: () => void run('assign', () => actions.assign(id, incident.owner)) },
                incident.status === 'resolved'
                  ? { label: 'Reopen incident', icon: RotateCcw, onSelect: () => void run('reopen', () => actions.reopen(id)) }
                  : !busy && { label: 'Mark resolved', icon: CircleCheck, onSelect: () => void run('resolve', () => actions.resolve(id)) },
                'separator',
                { label: 'Copy incident ID', icon: Copy, onSelect: () => void actions.copy(incident.id, 'Incident ID') },
                { label: 'Copy link', icon: Link2, onSelect: () => void actions.copy(link, 'Link') },
                a && { label: 'Copy root cause', icon: Brain, onSelect: () => void actions.copy(a.result.probableRootCause, 'Root cause') },
                {
                  label: 'Export as JSON',
                  icon: Download,
                  onSelect: () => downloadFile(`${incident.id}.json`, JSON.stringify(incident, null, 2)),
                },
                'separator',
                { label: 'Delete incident', icon: Trash2, danger: true, onSelect: () => void remove() },
              ]}
            />
          </div>
        </div>
        <Pipeline incident={incident} />
      </section>

      {actionError && <ErrorBox message={actionError} />}
      {loadError && <ErrorBox message={`Refresh failed: ${loadError}`} />}

      {incident.status === 'investigating' && (
        <div className="relative overflow-hidden rounded-2xl border border-sky-500/30 bg-sky-500/10 p-4 text-sm text-sky-100">
          <div className="absolute inset-y-0 left-0 w-1/3 animate-shimmer bg-gradient-to-r from-transparent via-sky-400/15 to-transparent" />
          <div className="relative flex flex-wrap items-center gap-3">
            <Sparkles className="h-4 w-4 flex-shrink-0 text-sky-300" />
            <span className="min-w-0 flex-1">
              Nagent is investigating{model ? ` with ${model}` : ''}. A local model on CPU can take several minutes — this page updates automatically.
            </span>
            {startedAt && (
              <span className="rounded-md bg-sky-500/15 px-2 py-0.5 font-mono text-xs tabular-nums text-sky-200 ring-1 ring-sky-500/30">
                {duration(now - new Date(startedAt).getTime())}
              </span>
            )}
            {analyzing && (
              <button onClick={stop} disabled={acting !== null} className="text-xs font-medium text-sky-100 underline underline-offset-2 hover:no-underline">
                Stop
              </button>
            )}
          </div>
        </div>
      )}
      {incident.status === 'cancelled' && (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-edge-strong bg-panel-2/70 p-4 text-sm text-fg-soft">
          <Square className="h-4 w-4 flex-shrink-0 fill-current text-fg-muted" />
          <span className="min-w-0 flex-1">The investigation was stopped before it finished. Nothing was changed in the repository.</span>
          <button onClick={() => void act('ai', () => api.investigate(id, 'ai'), 'Investigation started')} disabled={acting !== null} className="btn-secondary h-8 px-3 text-xs">
            <RotateCcw className="h-3.5 w-3.5" /> Run again
          </button>
        </div>
      )}
      {incident.status === 'failed' && incident.error && <ErrorBox message={`Investigation failed: ${incident.error}`} />}
      {incident.status === 'rejected' && (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-fuchsia-500/30 bg-fuchsia-500/10 p-4 text-sm text-fuchsia-100">
          <Ban className="h-4 w-4 flex-shrink-0" />
          <span className="min-w-0 flex-1">{r?.message ?? 'The proposed patch was rejected.'}</span>
          <button onClick={() => void act('ai', () => api.investigate(id, 'ai'), 'Investigation started')} disabled={acting !== null} className="btn-secondary h-8 px-3 text-xs">
            <RotateCcw className="h-3.5 w-3.5" /> Re-run investigation
          </button>
        </div>
      )}
      {incident.status === 'resolved' && (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-teal-500/30 bg-teal-500/10 p-4 text-sm text-teal-100">
          <CircleCheck className="h-4 w-4 flex-shrink-0" />
          <span className="min-w-0 flex-1">Resolved {incident.resolvedAt ? timeAgo(incident.resolvedAt) : ''}.</span>
          <button onClick={() => void run('reopen', () => actions.reopen(id))} disabled={acting !== null} className="btn-secondary h-8 px-3 text-xs">
            <RotateCcw className="h-3.5 w-3.5" /> Reopen
          </button>
        </div>
      )}

      <div className="grid items-start gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card title="Incident report" icon={<FileCode2 className="h-4 w-4" />}>
            {incident.description ? (
              <p className="whitespace-pre-wrap break-words text-sm text-fg-soft">{incident.description}</p>
            ) : (
              <p className="text-sm text-fg-muted">No description.</p>
            )}
            {incident.logs && (
              <pre className="scrollbar-thin mt-4 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-edge bg-black/40 p-4 font-mono text-xs text-emerald-200/90">{incident.logs}</pre>
            )}
          </Card>

          {a ? (
            <RcaReport analysis={a} />
          ) : (
            incident.status !== 'investigating' && (
              <Card title="Root-cause analysis" icon={<Brain className="h-4 w-4" />}>
                <p className="text-sm text-fg-muted">No analysis yet. Start an investigation above.</p>
              </Card>
            )
          )}

          {r && <ProposedFix incident={incident} />}
          {r && <Validation checks={r.checks} />}
        </div>

        <div className="space-y-6">
          <PullRequestCard incident={incident} />
          <Card title="Timeline" icon={<Clock className="h-4 w-4" />}>
            <ol className="relative ml-1.5 space-y-4 border-l border-edge-strong">
              {incident.timeline.map((e, i) => (
                <li key={i} className="relative pl-5">
                  <span
                    className={`absolute -left-[5px] top-1.5 h-2.5 w-2.5 rounded-full ring-4 ring-panel ${
                      e.type === 'error' ? 'bg-rose-400' : e.type === 'pr' ? 'bg-emerald-400' : e.type === 'analysis' ? 'bg-violet-400' : e.type === 'notify' ? 'bg-cyan-400' : e.type === 'approval' ? 'bg-amber-400' : e.type === 'status' ? 'bg-teal-400' : 'bg-fg-muted'
                    }`}
                  />
                  <p className="break-words text-sm text-fg-soft">{e.message}</p>
                  <p className="font-mono text-[10px] text-fg-muted" title={new Date(e.at).toLocaleString()}>
                    {new Date(e.at).toLocaleTimeString()} · {e.type}
                    {e.actor && ` · ${e.actor}`}
                  </p>
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>
    </div>
  );
}

// ---------- pipeline tracker ----------

type StepState = 'done' | 'active' | 'failed' | 'pending' | 'skipped' | 'stopped';

function pipelineSteps(incident: Incident): Array<{ label: string; icon: LucideIcon; state: StepState }> {
  const a = incident.analysis;
  const r = incident.remediation;
  const notified = incident.timeline.some((e) => e.type === 'notify');
  const checksFailed = r?.checks.some((c) => c.status === 'failed');
  const analyzing = incident.status === 'investigating';
  return [
    { label: 'Reported', icon: Check, state: 'done' },
    { label: 'Teams', icon: Bell, state: notified ? 'done' : 'skipped' },
    {
      label: 'Analysis',
      icon: Brain,
      state: a ? 'done' : analyzing ? 'active' : incident.status === 'failed' ? 'failed' : incident.status === 'cancelled' ? 'stopped' : 'pending',
    },
    { label: 'Patch', icon: FileDiff, state: r ? 'done' : 'pending' },
    { label: 'Validation', icon: ShieldCheck, state: !r ? 'pending' : checksFailed ? 'failed' : 'done' },
    {
      label: 'Approval',
      icon: UserCheck,
      state: r?.pr || incident.status === 'creating_pr' ? 'done' : r?.status === 'rejected' ? 'failed' : incident.status === 'awaiting_approval' ? 'active' : 'pending',
    },
    {
      label: 'Pull request',
      icon: GitPullRequest,
      state: r?.pr ? 'done' : incident.status === 'creating_pr' ? 'active' : r?.status === 'pr_failed' ? 'failed' : 'pending',
    },
  ];
}

const STEP_STYLE: Record<StepState, string> = {
  done: 'bg-gradient-to-br from-violet-500 to-cyan-500 text-white shadow-glow',
  active: 'bg-sky-500/20 text-sky-200 ring-2 ring-sky-400/70',
  failed: 'bg-rose-500/20 text-rose-200 ring-2 ring-rose-500/60',
  pending: 'bg-panel-3 text-fg-muted ring-1 ring-edge',
  skipped: 'bg-panel-3 text-fg-muted/60 ring-1 ring-edge',
  stopped: 'bg-slate-500/20 text-slate-200 ring-2 ring-slate-400/50',
};

function Pipeline({ incident }: { incident: Incident }) {
  const steps = pipelineSteps(incident);
  return (
    <ol className="scrollbar-thin relative mt-6 flex items-start overflow-x-auto pb-1" aria-label="Investigation progress">
      {steps.map((s, i) => {
        const Icon = s.state === 'failed' ? X : s.state === 'active' ? Loader2 : s.state === 'stopped' ? Square : s.icon;
        const next = i + 1 < steps.length ? steps[i + 1] : undefined;
        return (
          <li key={s.label} className="flex min-w-[84px] flex-1 flex-col items-center">
            <div className="flex w-full items-center">
              <span className={`h-0.5 flex-1 ${i === 0 ? 'opacity-0' : s.state === 'done' ? 'bg-violet-500/70' : 'bg-edge'}`} />
              <span className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full ${STEP_STYLE[s.state]}`} title={s.state}>
                <Icon className={`h-4 w-4 ${s.state === 'active' ? 'animate-spin' : ''}`} />
              </span>
              <span className={`h-0.5 flex-1 ${!next ? 'opacity-0' : next.state === 'done' ? 'bg-violet-500/70' : 'bg-edge'}`} />
            </div>
            <span className={`mt-2 text-center text-[11px] font-medium ${s.state === 'pending' || s.state === 'skipped' ? 'text-fg-muted' : 'text-fg-soft'}`}>
              {s.label}
              {(s.state === 'skipped' || s.state === 'stopped') && <span className="block text-[10px] font-normal">{s.state}</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

// ---------- sections ----------

function BackLink() {
  return (
    <a href="#/incidents" className="inline-flex items-center gap-1.5 text-sm text-fg-muted transition hover:text-fg">
      <ArrowLeft className="h-4 w-4" /> All incidents
    </a>
  );
}

function List({ items, empty = 'None' }: { items: string[]; empty?: string }) {
  if (!items.length) return <p className="text-sm text-fg-muted">{empty}</p>;
  return (
    <ul className="space-y-1.5 text-sm text-fg-soft">
      {items.map((t, i) => (
        <li key={i} className="flex gap-2 break-words">
          <span className="mt-2 h-1 w-1 flex-shrink-0 rounded-full bg-violet-400" />
          <span>{t}</span>
        </li>
      ))}
    </ul>
  );
}

function ConfidenceGauge({ value }: { value: number }) {
  const radius = 34;
  const circumference = 2 * Math.PI * radius;
  return (
    <div className="relative h-24 w-24 flex-shrink-0" role="meter" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100} aria-label="Confidence">
      <svg viewBox="0 0 80 80" className="h-full w-full -rotate-90">
        <defs>
          <linearGradient id="gauge" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#8b5cf6" />
            <stop offset="1" stopColor="#22d3ee" />
          </linearGradient>
        </defs>
        <circle cx="40" cy="40" r={radius} fill="none" stroke="#1f2940" strokeWidth="7" />
        <circle cx="40" cy="40" r={radius} fill="none" stroke="url(#gauge)" strokeWidth="7" strokeLinecap="round" strokeDasharray={`${(value / 100) * circumference} ${circumference}`} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-display text-xl font-bold text-fg">{value}%</span>
        <span className="text-[9px] uppercase tracking-wider text-fg-muted">confidence</span>
      </div>
    </div>
  );
}

function RcaReport({ analysis }: { analysis: NonNullable<Incident['analysis']> }) {
  const r = analysis.result;
  const facts = r.evidence.filter((e) => e.type === 'fact');
  const hypotheses = r.evidence.filter((e) => e.type === 'hypothesis');
  const demo = analysis.mode === 'demo';
  return (
    <Card
      title="Root-cause analysis"
      icon={<Brain className="h-4 w-4" />}
      right={<span className="rounded-md bg-panel-3 px-2 py-0.5 font-mono text-[11px] text-fg-muted ring-1 ring-edge">{demo ? 'demo heuristic' : `ollama · ${analysis.model}`}</span>}
    >
      {demo && (
        <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          <strong>DEMO MODE</strong> — produced by a keyword heuristic, not an AI model. Do not treat it as a real root cause.
        </div>
      )}

      <div className="mb-5 flex flex-col gap-5 rounded-2xl border border-violet-500/25 bg-gradient-to-br from-violet-500/10 via-transparent to-cyan-500/5 p-5 sm:flex-row sm:items-center">
        <ConfidenceGauge value={r.confidence} />
        <div className="min-w-0">
          <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.15em] text-violet-300">Probable root cause · hypothesis</h3>
          <p className="break-words text-[15px] leading-relaxed text-fg">{r.probableRootCause}</p>
          <p className="mt-2 break-words text-sm text-fg-muted">{r.summary}</p>
        </div>
      </div>

      <div className="mb-5 grid gap-4 md:grid-cols-2">
        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4">
          <h3 className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-emerald-300">
            <ShieldCheck className="h-4 w-4" /> Verified facts <span className="text-emerald-300/60">({facts.length})</span>
          </h3>
          {facts.length ? (
            <ul className="space-y-3">
              {facts.map((f, i) => (
                <li key={i} className="text-sm text-fg-soft">
                  {f.source && (
                    <span
                      className={`mr-1.5 inline-block rounded px-1.5 py-px font-mono text-[10px] ${f.source === 'repository' ? 'bg-emerald-500/20 text-emerald-200' : 'bg-amber-500/20 text-amber-200'}`}
                      title={f.source === 'repository' ? 'Found in the repository code' : 'Found in the incident report — a claim, not confirmed by the code'}
                    >
                      {f.source === 'repository' ? 'repository' : 'report'}
                    </span>
                  )}
                  {f.statement}
                  {f.quote && (
                    <code className="mt-1.5 block whitespace-pre-wrap break-words rounded-lg border border-edge bg-black/40 px-2.5 py-1.5 font-mono text-xs text-fg">{f.quote}</code>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-fg-muted">No verifiable facts — all findings are unconfirmed.</p>
          )}
          <p className="mt-3 text-[11px] text-fg-muted">“report” = what the reporter wrote (a claim) · “repository” = what the code says</p>
        </div>
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
          <h3 className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-amber-200">
            <Brain className="h-4 w-4" /> Hypotheses <span className="text-amber-200/60">({hypotheses.length})</span>
          </h3>
          <List items={hypotheses.map((h) => h.statement)} />
        </div>
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        <div>
          <h3 className="mb-1.5 text-sm font-semibold text-fg">Recommended fix</h3>
          <p className="break-words text-sm text-fg-soft">{r.recommendedFix || '—'}</p>
        </div>
        <div>
          <h3 className="mb-1.5 text-sm font-semibold text-fg">Validation plan</h3>
          <List items={r.validationPlan} />
        </div>
        <div>
          <h3 className="mb-1.5 text-sm font-semibold text-fg">Preventive actions</h3>
          <List items={r.preventiveActions} />
        </div>
        <div>
          <h3 className="mb-1.5 text-sm font-semibold text-fg">Limitations</h3>
          <List items={r.limitations} />
        </div>
      </div>
    </Card>
  );
}

function ProposedFix({ incident }: { incident: Incident }) {
  const r = incident.remediation!;
  const tone =
    r.status === 'validation_failed' || r.status === 'pr_failed'
      ? 'border-rose-500/30 bg-rose-500/10 text-rose-200'
      : r.status === 'not_configured' || r.status === 'blocked'
        ? 'border-amber-500/30 bg-amber-500/10 text-amber-100'
        : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200';
  return (
    <Card
      title="Proposed fix"
      icon={<FileDiff className="h-4 w-4" />}
      right={r.repo && <span className="rounded-md bg-panel-3 px-2 py-0.5 font-mono text-[11px] text-fg-muted ring-1 ring-edge">{r.provider === 'mock' ? 'MOCK ' : ''}{r.repo}@{r.baseBranch}</span>}
    >
      {r.message && <div className={`mb-4 rounded-xl border px-4 py-3 text-sm ${tone}`}>{r.message}</div>}
      <div className="space-y-3">
        {r.changes.map((c) => (
          <FileDiffBlock key={c.path} change={c} defaultOpen={!c.path.startsWith('docs/incidents/') || r.changes.length === 1} />
        ))}
      </div>
      {r.rejected.length > 0 && (
        <div className="mt-5 rounded-xl border border-edge bg-panel-2/60 p-4">
          <h3 className="mb-2 text-sm font-semibold text-fg">Model suggestions not applied ({r.rejected.length})</h3>
          <ul className="space-y-1.5 text-sm">
            {r.rejected.map((x, i) => (
              <li key={i} className="break-words text-fg-soft">
                <span className="font-mono text-xs text-fg">{x.file}</span> — {x.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function Validation({ checks }: { checks: NonNullable<Incident['remediation']>['checks'] }) {
  const failed = checks.filter((c) => c.status === 'failed').length;
  const passed = checks.filter((c) => c.status === 'passed').length;
  return (
    <Card
      title="Validation results"
      icon={<ShieldCheck className="h-4 w-4" />}
      right={
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ${failed ? 'bg-rose-500/15 text-rose-300 ring-rose-500/40' : 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/40'}`}>
          {failed ? `${failed} failed` : `${passed}/${checks.length} passed`}
        </span>
      }
    >
      <p className="mb-3 text-xs text-fg-muted">Static checks run by Nagent on the patched files. No model-generated commands are executed.</p>
      <div className="divide-y divide-edge overflow-hidden rounded-xl border border-edge">
        {checks.map((c, i) => (
          <div key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-panel-2/40 px-4 py-2.5 text-sm">
            {c.status === 'passed' ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-400" aria-label="passed" />
            ) : c.status === 'failed' ? (
              <XCircle className="h-4 w-4 text-rose-400" aria-label="failed" />
            ) : (
              <MinusCircle className="h-4 w-4 text-fg-muted" aria-label="skipped" />
            )}
            <span className="w-32 font-mono text-xs text-fg">{c.name}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-muted" title={c.file}>{c.file}</span>
            <span className="w-full text-xs text-fg-soft sm:w-auto">{c.detail}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function PullRequestCard({ incident }: { incident: Incident }) {
  const r = incident.remediation;
  const pr = r?.pr;
  const gitlab = r?.provider === 'gitlab';
  if (pr) {
    const real = !pr.mock && /^https:\/\//.test(pr.url);
    return (
      <section className="animate-fade-up overflow-hidden rounded-2xl border border-emerald-500/30 bg-gradient-to-br from-emerald-500/15 via-panel to-panel shadow-panel">
        <div className="p-5">
          <div className="mb-3 flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/40">
              <GitPullRequest className="h-4 w-4" />
            </span>
            <div>
              <h2 className="font-display font-semibold text-fg">{gitlab ? `Merge request !${pr.number}` : `Pull request #${pr.number}`}</h2>
              <p className="text-xs text-emerald-300/80">{pr.draft ? 'Draft · RCA only' : 'Ready for review'}</p>
            </div>
          </div>
          {pr.mock && <p className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-100">Mock PR — created in the in-memory test repository, not on GitHub.</p>}
          {real ? (
            <a href={pr.url} target="_blank" rel="noopener noreferrer" className="btn-primary w-full">
              View on {gitlab ? 'GitLab' : 'GitHub'} <ExternalLink className="h-3.5 w-3.5" />
            </a>
          ) : (
            <p className="break-all font-mono text-xs text-fg-soft">{pr.url}</p>
          )}
          <p className="mt-3 break-all font-mono text-[11px] text-fg-muted">
            {r!.branch} → {r!.baseBranch}
          </p>
        </div>
      </section>
    );
  }
  const short = gitlab ? 'MR' : 'PR';
  const text: Record<string, string> = {
    not_configured: 'The repository is not configured — no PR/MR can be created.',
    blocked: `${short} creation blocked for demo analyses.`,
    validation_failed: `Validation failed — ${short} creation is disabled.`,
    awaiting_approval: `Waiting for your approval. Review the patch, then click “Approve & create ${short}”.`,
    creating_pr: `Creating branch, commit and ${gitlab ? 'merge' : 'pull'} request…`,
    pr_failed: `The last ${short} attempt failed — you can approve again to retry.`,
  };
  return (
    <Card title={gitlab ? 'Merge request' : 'Pull request'} icon={<GitPullRequest className="h-4 w-4" />}>
      <p className="text-sm text-fg-muted">{r ? text[r.status] ?? r.status : 'No patch yet.'}</p>
    </Card>
  );
}
