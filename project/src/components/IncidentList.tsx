import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertOctagon, ChevronRight, GitPullRequest, Hourglass, Inbox, Layers, Plus, Radar, RefreshCw, Search } from 'lucide-react';
import { api, type IncidentSummary, type Severity } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { ReportIncidentDialog } from './ReportIncidentDialog';
import { ErrorBox, SeverityBadge, Spinner, StatusBadge } from './ui';

const SEVERITY_BAR: Record<Severity, string> = {
  critical: 'bg-rose-500',
  high: 'bg-orange-500',
  medium: 'bg-amber-400',
  low: 'bg-slate-500',
};

type Filter = 'all' | 'active' | 'approval' | 'pr' | 'failed';

const FILTERS: Array<{ id: Filter; label: string; test: (i: IncidentSummary) => boolean }> = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'active', label: 'In progress', test: (i) => i.running || ['open', 'investigating', 'creating_pr'].includes(i.status) },
  { id: 'approval', label: 'Needs approval', test: (i) => i.status === 'awaiting_approval' },
  { id: 'pr', label: 'PR created', test: (i) => i.status === 'pr_created' },
  { id: 'failed', label: 'Failed', test: (i) => i.status === 'failed' },
];

export function IncidentList({ navigate }: { navigate: (hash: string) => void }) {
  const [incidents, setIncidents] = useState<IncidentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reporting, setReporting] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');

  const load = useCallback(async () => {
    try {
      setIncidents(await api.list());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const count = (id: Filter) => incidents?.filter(FILTERS.find((f) => f.id === id)!.test).length ?? 0;
  const stats = [
    { label: 'Total incidents', value: incidents?.length ?? 0, icon: Layers, tint: 'from-violet-500/30 to-violet-500/5 text-violet-200' },
    { label: 'In progress', value: count('active'), icon: Radar, tint: 'from-sky-500/30 to-sky-500/5 text-sky-200' },
    { label: 'Needs approval', value: count('approval'), icon: Hourglass, tint: 'from-amber-500/30 to-amber-500/5 text-amber-200' },
    { label: 'PRs created', value: count('pr'), icon: GitPullRequest, tint: 'from-emerald-500/30 to-emerald-500/5 text-emerald-200' },
    { label: 'Failed', value: count('failed'), icon: AlertOctagon, tint: 'from-rose-500/30 to-rose-500/5 text-rose-200' },
  ];

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const test = FILTERS.find((f) => f.id === filter)!.test;
    return (incidents ?? []).filter(
      (i) => test(i) && (!q || [i.title, i.id, i.service ?? '', i.environment ?? ''].some((v) => v.toLowerCase().includes(q))),
    );
  }, [incidents, filter, query]);

  return (
    <div className="space-y-8">
      <section className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-[0.2em] text-violet-300/80">Incident command</p>
          <h1 className="font-display text-3xl font-bold tracking-tight text-fg sm:text-4xl">
            Every incident, <span className="brand-text">investigated</span>.
          </h1>
          <p className="mt-2 max-w-xl text-sm text-fg-soft">
            Nagent reads the code, finds the probable root cause, proposes a minimal fix and opens a pull request once you approve.
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => void load()} className="btn-secondary px-3" aria-label="Refresh">
            <RefreshCw className="h-4 w-4" />
          </button>
          <button onClick={() => setReporting(true)} className="btn-primary">
            <Plus className="h-4 w-4" /> Report incident
          </button>
        </div>
      </section>

      {incidents && (
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {stats.map((s, i) => (
            <div
              key={s.label}
              style={{ animationDelay: `${i * 50}ms` }}
              className="animate-fade-up rounded-2xl border border-edge bg-panel/80 p-4 shadow-panel backdrop-blur"
            >
              <div className={`mb-3 inline-flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br ${s.tint}`}>
                <s.icon className="h-4 w-4" />
              </div>
              <div className="font-display text-3xl font-bold tabular-nums text-fg">{s.value}</div>
              <div className="text-xs text-fg-muted">{s.label}</div>
            </div>
          ))}
        </section>
      )}

      {error && <ErrorBox message={error} onRetry={() => void load()} />}
      {!incidents && !error && <Spinner label="Loading incidents…" />}

      {incidents && incidents.length === 0 && (
        <div className="rounded-2xl border border-dashed border-edge-strong bg-panel/60 p-12 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500/30 to-cyan-500/20 text-violet-200 shadow-glow">
            <Inbox className="h-6 w-6" />
          </div>
          <p className="font-display text-lg font-semibold text-fg">No incidents yet</p>
          <p className="mb-5 mt-1 text-sm text-fg-muted">Report one here or send an alert to the webhook.</p>
          <button onClick={() => setReporting(true)} className="btn-primary">
            <Plus className="h-4 w-4" /> Report incident
          </button>
        </div>
      )}

      {incidents && incidents.length > 0 && (
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-1 rounded-xl border border-edge bg-panel/70 p-1">
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  onClick={() => setFilter(f.id)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                    filter === f.id ? 'bg-gradient-to-r from-violet-500/30 to-cyan-500/20 text-fg ring-1 ring-violet-500/40' : 'text-fg-muted hover:text-fg'
                  }`}
                >
                  {f.label}
                  <span className="ml-1.5 tabular-nums text-fg-muted">{count(f.id)}</span>
                </button>
              ))}
            </div>
            <label className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted" />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search title, ID, service…" className="field pl-9" />
            </label>
          </div>

          {visible.length === 0 ? (
            <p className="rounded-2xl border border-edge bg-panel/60 p-8 text-center text-sm text-fg-muted">No incidents match this filter.</p>
          ) : (
            <ul className="space-y-2">
              {visible.map((i, idx) => (
                <li key={i.id} style={{ animationDelay: `${Math.min(idx, 10) * 30}ms` }} className="animate-fade-up">
                  <a
                    href={`#/incidents/${i.id}`}
                    onClick={(e) => {
                      e.preventDefault();
                      navigate(`#/incidents/${i.id}`);
                    }}
                    className="group relative flex items-center gap-4 overflow-hidden rounded-2xl border border-edge bg-panel/80 py-4 pl-5 pr-4 shadow-panel backdrop-blur transition hover:-translate-y-0.5 hover:border-violet-500/40 hover:bg-panel-2"
                  >
                    <span className={`absolute inset-y-0 left-0 w-1 ${SEVERITY_BAR[i.severity]}`} />
                    <div className="min-w-0 flex-1">
                      <div className="mb-1 flex flex-wrap items-center gap-2">
                        <SeverityBadge severity={i.severity} />
                        <StatusBadge status={i.status} />
                        {i.prUrl && (
                          <span className="inline-flex items-center gap-1 text-[11px] text-emerald-300">
                            <GitPullRequest className="h-3 w-3" /> PR
                          </span>
                        )}
                        {i.analysisMode === 'demo' && <span className="rounded bg-amber-500/15 px-1.5 text-[10px] font-semibold text-amber-200">DEMO</span>}
                      </div>
                      <p className="truncate font-medium text-fg group-hover:text-white">{i.title}</p>
                      <p className="mt-0.5 font-mono text-[11px] text-fg-muted">
                        {i.id} · {i.source}
                        {i.service && ` · ${i.service}`}
                        {i.environment && ` · ${i.environment}`}
                        {i.occurrences > 1 && ` · ×${i.occurrences}`}
                      </p>
                    </div>
                    <div className="hidden w-28 md:block">
                      {i.confidence !== undefined ? (
                        <>
                          <div className="mb-1 flex justify-between text-[11px] text-fg-muted">
                            <span>Confidence</span>
                            <span className="tabular-nums text-fg-soft">{i.confidence}%</span>
                          </div>
                          <div className="h-1.5 overflow-hidden rounded-full bg-panel-3">
                            <div className="h-full rounded-full bg-gradient-to-r from-violet-500 to-cyan-400" style={{ width: `${i.confidence}%` }} />
                          </div>
                        </>
                      ) : (
                        <span className="text-[11px] text-fg-muted">No RCA yet</span>
                      )}
                    </div>
                    <span className="hidden w-16 text-right text-xs text-fg-muted sm:block">{timeAgo(i.createdAt)}</span>
                    <ChevronRight className="h-4 w-4 text-fg-muted transition group-hover:translate-x-0.5 group-hover:text-violet-300" />
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {reporting && (
        <ReportIncidentDialog
          onClose={() => setReporting(false)}
          onCreated={(id) => {
            setReporting(false);
            navigate(`#/incidents/${id}`);
          }}
        />
      )}
    </div>
  );
}
