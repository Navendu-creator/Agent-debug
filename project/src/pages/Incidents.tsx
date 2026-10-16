import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertOctagon, Bookmark, CalendarDays, ChevronLeft, ChevronRight, CircleDot, GitPullRequest, Globe, Hourglass, Inbox, Layers, OctagonAlert,
  Plus, Search, Square, Trash2, UserRound, X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useIncidentActions } from '@/components/actions';
import { usePrompt } from '@/components/feedback';
import { IncidentDrawer } from '@/components/IncidentDrawer';
import { IncidentTable } from '@/components/IncidentTable';
import { MenuHeading, MultiSelect, Popover, Select } from '@/components/menu';
import { Delta, ErrorBox, PageHeader, RepoIcon, SEVERITIES, SEVERITY_COLOR, SEVERITY_LABEL, Spinner, StatCard } from '@/components/ui';
import type { IncidentStatus, Severity } from '@/lib/api';
import { ALL_ENVIRONMENTS, DAY, isActive, isOpen, stoppable, useData } from '@/lib/data';
import { isTyping } from '@/lib/format';
import { repositories, useHealth } from '@/lib/health';

const STATUS_OPTIONS: Array<{ value: IncidentStatus; label: string }> = [
  { value: 'open', label: 'New' },
  { value: 'investigating', label: 'Investigating' },
  { value: 'rca_ready', label: 'RCA ready' },
  { value: 'awaiting_approval', label: 'Awaiting approval' },
  { value: 'creating_pr', label: 'Creating PR' },
  { value: 'pr_created', label: 'PR created' },
  { value: 'rejected', label: 'Patch rejected' },
  { value: 'cancelled', label: 'Stopped' },
  { value: 'failed', label: 'Failed' },
  { value: 'resolved', label: 'Resolved' },
];

type Range = 'all' | '24h' | '7d' | '30d';
const RANGES: Record<Range, { label: string; ms: number }> = {
  all: { label: 'All time', ms: Infinity },
  '24h': { label: 'Last 24 hours', ms: DAY },
  '7d': { label: 'Last 7 days', ms: 7 * DAY },
  '30d': { label: 'Last 30 days', ms: 30 * DAY },
};

/** Quick views; they combine with the dropdown filters. */
type View = 'all' | 'open' | 'critical' | 'mine' | `env:${string}`;

interface Filters {
  q: string;
  severities: Severity[];
  statuses: IncidentStatus[];
  repo: string;
  range: Range;
  view: View;
  environment: string;
}

interface SavedView {
  name: string;
  filters: Filters;
}

const EMPTY: Omit<Filters, 'environment'> = { q: '', severities: [], statuses: [], repo: 'all', range: 'all', view: 'all' };

function readJson<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(`nagent.${key}`) ?? '') as T;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(`nagent.${key}`, JSON.stringify(value));
  } catch {
    // per-browser convenience only
  }
}

/** Filters from the URL: #/incidents?service=x&severity=critical&status=pr_created&repo=github-4&view=open&owner=me */
function fromQuery(query: URLSearchParams): Partial<Filters> {
  const out: Partial<Filters> = {};
  const q = query.get('q') ?? query.get('service');
  if (q) out.q = q;
  const sev = query.get('severity');
  if (sev) out.severities = sev.split(',').filter((s): s is Severity => (SEVERITIES as string[]).includes(s));
  const st = query.get('status');
  if (st) out.statuses = st.split(',').filter((s): s is IncidentStatus => STATUS_OPTIONS.some((o) => o.value === s));
  const repo = query.get('repo');
  if (repo) out.repo = repo;
  const view = query.get('view');
  if (view === 'open' || view === 'critical') out.view = view;
  if (query.get('owner') === 'me') out.view = 'mine';
  return out;
}

export function Incidents({ query, navigate }: { query: URLSearchParams; navigate: (hash: string) => void }) {
  const { incidents, error, refresh, environment, setEnvironment, environments, operator } = useData();
  const { health } = useHealth();
  const repos = repositories(health);
  const actions = useIncidentActions();
  const prompt = usePrompt();
  const search = useRef<HTMLInputElement>(null);
  const pageSize = Number(readJson('pageSize', 10)) || 10;

  const [f, setF] = useState<Omit<Filters, 'environment'>>(() => ({ ...EMPTY, ...fromQuery(query) }));
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [active, setActive] = useState<string | null>(null);
  const [views, setViews] = useState<SavedView[]>(() => readJson('views', []));

  const queryKey = query.toString();
  useEffect(() => {
    if (queryKey) setF({ ...EMPTY, ...fromQuery(new URLSearchParams(queryKey)) });
  }, [queryKey]);

  useEffect(() => setPage(1), [f, environment]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || isTyping(e.target) || document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault();
      search.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const set = <K extends keyof typeof f>(key: K, value: (typeof f)[K]) => setF((x) => ({ ...x, [key]: value }));
  const now = Date.now();
  const all = useMemo(() => incidents ?? [], [incidents]);
  const inEnv = useMemo(() => (environment === ALL_ENVIRONMENTS ? all : all.filter((i) => i.environment === environment)), [all, environment]);

  const visible = useMemo(() => {
    const q = f.q.trim().toLowerCase();
    const since = now - RANGES[f.range].ms;
    return inEnv
      .filter((i) => {
        if (f.view === 'open' && !isOpen(i)) return false;
        if (f.view === 'critical' && !(i.severity === 'critical' && isOpen(i))) return false;
        if (f.view === 'mine' && (!operator || i.owner?.toLowerCase() !== operator.toLowerCase())) return false;
        if (f.view.startsWith('env:') && i.environment !== f.view.slice(4)) return false;
        if (f.severities.length && !f.severities.includes(i.severity)) return false;
        if (f.statuses.length && !f.statuses.includes(i.status)) return false;
        if (f.repo !== 'all' && i.repoTarget !== f.repo) return false;
        if (Date.parse(i.createdAt) < since) return false;
        if (q) {
          const repoName = repos.find((r) => r.id === i.repoTarget)?.name ?? '';
          return [i.title, i.id, i.service ?? '', i.environment ?? '', i.snippet, i.owner ?? '', repoName].some((v) => v.toLowerCase().includes(q));
        }
        return true;
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    // `now` changes every render; the list refreshes every 5 s anyway
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inEnv, f, operator, repos.length]);

  const pages = Math.max(1, Math.ceil(visible.length / pageSize));
  const current = Math.min(page, pages);
  const rows = visible.slice((current - 1) * pageSize, current * pageSize);
  const filtered = JSON.stringify(f) !== JSON.stringify(EMPTY);

  // ----- KPI cards (environment-scoped, ignoring the other filters) -----
  const total = inEnv.length;
  const pct = (n: number) => (total ? `${Math.round((n / total) * 100)}% of total` : '—');
  const count = (test: (i: (typeof inEnv)[number]) => boolean) => inEnv.filter(test).length;
  const toggleStatus = (statuses: IncidentStatus[]) =>
    set('statuses', JSON.stringify(f.statuses) === JSON.stringify(statuses) ? [] : statuses);

  // ----- quick views -----
  const envChips = environments.slice(0, 3);
  const chips: Array<{ view: View; label: string; icon: LucideIcon; n: number }> = [
    { view: 'all', label: 'All incidents', icon: Layers, n: inEnv.length },
    { view: 'open', label: 'Open', icon: CircleDot, n: count(isOpen) },
    { view: 'critical', label: 'Critical', icon: OctagonAlert, n: count((i) => i.severity === 'critical' && isOpen(i)) },
    ...(environment === ALL_ENVIRONMENTS
      ? envChips.map((e) => ({ view: `env:${e}` as View, label: e[0].toUpperCase() + e.slice(1), icon: Globe, n: count((i) => i.environment === e) }))
      : []),
    { view: 'mine', label: 'My incidents', icon: UserRound, n: operator ? count((i) => i.owner?.toLowerCase() === operator.toLowerCase()) : 0 },
  ];

  const saveView = async () => {
    const name = await prompt({ title: 'Save current view', label: 'View name', placeholder: 'e.g. Critical in production', required: true, confirmLabel: 'Save view' });
    if (!name) return;
    const next = [...views.filter((v) => v.name !== name), { name, filters: { ...f, environment } }];
    setViews(next);
    writeJson('views', next);
  };
  const applyView = (v: SavedView) => {
    setF({ ...EMPTY, ...v.filters });
    setEnvironment(v.filters.environment ?? ALL_ENVIRONMENTS);
  };
  const deleteView = (name: string) => {
    const next = views.filter((v) => v.name !== name);
    setViews(next);
    writeJson('views', next);
  };

  // ----- selection -----
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const toggleAll = () => setSelected(rows.every((r) => selected.has(r.id)) ? new Set() : new Set(rows.map((r) => r.id)));
  const selectedList = all.filter((i) => selected.has(i.id));
  const selectedStoppable = selectedList.filter(stoppable).map((i) => i.id);

  useEffect(() => {
    if (incidents) setSelected((s) => new Set([...s].filter((id) => incidents.some((i) => i.id === id))));
    if (incidents && active && !incidents.some((i) => i.id === active)) setActive(null);
  }, [incidents, active]);

  if (!incidents) return error ? <ErrorBox message={error} onRetry={() => void refresh()} /> : <Spinner label="Loading incidents…" />;

  return (
    <div className={`grid items-start gap-5 ${active ? 'min-[1800px]:grid-cols-[minmax(0,1fr)_420px]' : ''}`}>
      <div className="min-w-0 space-y-5">
        <PageHeader title="Incidents" subtitle="Nagent analyzes, finds the root cause and proposes a fix — all changes require your approval." />
        {error && <ErrorBox message={error} onRetry={() => void refresh()} />}

        <section className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
          <StatCard
            label="Total incidents"
            value={total}
            icon={<Layers className="h-5 w-5" />}
            tint="bg-violet-500/20 text-violet-200 ring-1 ring-violet-500/40"
            foot={<Delta value={count((i) => now - Date.parse(i.createdAt) < DAY)} label="in last 24h" />}
            active={!f.statuses.length && f.view === 'all'}
            onClick={() => setF((x) => ({ ...x, statuses: [], view: 'all' }))}
          />
          <StatCard
            label="In progress"
            value={count(isActive)}
            icon={<CircleDot className="h-5 w-5" />}
            tint="bg-sky-500/20 text-sky-200 ring-1 ring-sky-500/40"
            foot={pct(count(isActive))}
            active={JSON.stringify(f.statuses) === JSON.stringify(['open', 'investigating', 'creating_pr'])}
            onClick={() => toggleStatus(['open', 'investigating', 'creating_pr'])}
          />
          <StatCard
            label="Needs approval"
            value={count((i) => i.status === 'awaiting_approval')}
            icon={<Hourglass className="h-5 w-5" />}
            tint="bg-amber-500/20 text-amber-200 ring-1 ring-amber-500/40"
            foot={pct(count((i) => i.status === 'awaiting_approval'))}
            active={JSON.stringify(f.statuses) === '["awaiting_approval"]'}
            onClick={() => toggleStatus(['awaiting_approval'])}
          />
          <StatCard
            label="PRs created"
            value={count((i) => i.status === 'pr_created')}
            icon={<GitPullRequest className="h-5 w-5" />}
            tint="bg-emerald-500/20 text-emerald-200 ring-1 ring-emerald-500/40"
            foot={pct(count((i) => i.status === 'pr_created'))}
            active={JSON.stringify(f.statuses) === '["pr_created"]'}
            onClick={() => toggleStatus(['pr_created'])}
          />
          <StatCard
            label="Failed"
            value={count((i) => i.status === 'failed')}
            icon={<AlertOctagon className="h-5 w-5" />}
            tint="bg-rose-500/20 text-rose-200 ring-1 ring-rose-500/40"
            foot={pct(count((i) => i.status === 'failed'))}
            active={JSON.stringify(f.statuses) === '["failed"]'}
            onClick={() => toggleStatus(['failed'])}
          />
        </section>

        <section className="flex flex-wrap items-center gap-2">
          <label className="relative min-w-[220px] flex-1 lg:max-w-sm">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted" />
            <input
              ref={search}
              value={f.q}
              onChange={(e) => set('q', e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && (set('q', ''), e.currentTarget.blur())}
              placeholder="Search title, ID, service, repo, owner…"
              className="field h-9 py-0 pl-9 pr-9"
            />
            {!f.q && <kbd className="kbd pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2">/</kbd>}
          </label>
          <MultiSelect
            label="Severity"
            values={f.severities}
            onChange={(v) => set('severities', v)}
            options={SEVERITIES.map((s) => ({ value: s, label: SEVERITY_LABEL[s], icon: <span className="h-2 w-2 rounded-full" style={{ background: SEVERITY_COLOR[s] }} /> }))}
          />
          <MultiSelect label="Status" values={f.statuses} onChange={(v) => set('statuses', v)} options={STATUS_OPTIONS} />
          <Select
            ariaLabel="Environment"
            value={environment}
            onChange={setEnvironment}
            prefix={<span className="text-fg-muted">Environment:</span>}
            className={environment !== ALL_ENVIRONMENTS ? 'border-violet-500/50' : ''}
            options={[{ value: ALL_ENVIRONMENTS, label: 'All' }, ...environments.map((e) => ({ value: e, label: e }))]}
          />
          {repos.length > 1 && (
            <Select
              ariaLabel="Repository"
              value={f.repo}
              onChange={(v) => set('repo', v)}
              prefix={<span className="text-fg-muted">Repository:</span>}
              className={`max-w-[260px] ${f.repo !== 'all' ? 'border-violet-500/50' : ''}`}
              panelClassName="w-72"
              options={[
                { value: 'all', label: 'All' },
                ...repos.map((r) => ({ value: r.id, label: r.name.split('/').pop()!, description: r.name, icon: <RepoIcon provider={r.provider} /> })),
              ]}
            />
          )}
          <Select
            ariaLabel="Date range"
            value={f.range}
            onChange={(v) => set('range', v)}
            prefix={<CalendarDays className="h-3.5 w-3.5 text-fg-muted" />}
            className={f.range !== 'all' ? 'border-violet-500/50' : ''}
            options={(Object.keys(RANGES) as Range[]).map((r) => ({ value: r, label: RANGES[r].label }))}
          />
        </section>

        <section className="flex flex-wrap items-center gap-2">
          {chips.map((c) => (
            <button
              key={c.view}
              onClick={() => set('view', f.view === c.view && c.view !== 'all' ? 'all' : c.view)}
              aria-pressed={f.view === c.view}
              title={c.view === 'mine' && !operator ? 'Set your name in the top-right menu first' : undefined}
              className={`inline-flex h-9 items-center gap-2 rounded-xl border px-3 text-xs font-medium transition ${
                f.view === c.view ? 'border-violet-500/60 bg-violet-500/20 text-fg' : 'border-edge bg-panel/80 text-fg-soft hover:border-edge-strong hover:text-fg'
              }`}
            >
              <c.icon className="h-4 w-4" />
              {c.label}
              <span className="rounded-md bg-panel-3 px-1.5 tabular-nums text-fg-muted">{c.n}</span>
            </button>
          ))}
          <span className="flex-1" />
          {filtered && (
            <button onClick={() => setF(EMPTY)} className="btn-ghost h-9 px-3 text-xs">
              <X className="h-3.5 w-3.5" /> Clear filters
            </button>
          )}
          <Popover
            ariaLabel="Saved views"
            panelClassName="w-64"
            buttonClassName="btn-secondary h-9 gap-2 px-3 text-xs"
            button={
              <>
                <Bookmark className="h-4 w-4" /> Saved views
              </>
            }
          >
            {(close) => (
              <>
                <MenuHeading>Saved views</MenuHeading>
                {views.length === 0 && <p className="px-2.5 pb-2 text-xs text-fg-muted">No saved views yet.</p>}
                {views.map((v) => (
                  <div key={v.name} className="group flex items-center">
                    <button role="menuitem" className="menu-item flex-1" onClick={() => (applyView(v), close())}>
                      <Bookmark className="mt-0.5 h-4 w-4 text-fg-muted" /> <span className="truncate">{v.name}</span>
                    </button>
                    <button onClick={() => deleteView(v.name)} className="btn-icon h-7 w-7 opacity-60 hover:opacity-100" aria-label={`Delete view ${v.name}`} title="Delete view">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
                <div className="my-1 h-px bg-edge" />
                <button role="menuitem" className="menu-item" onClick={() => (close(), void saveView())}>
                  <Plus className="mt-0.5 h-4 w-4 text-fg-muted" /> Save current view…
                </button>
              </>
            )}
          </Popover>
        </section>

        <section className="overflow-hidden rounded-xl border border-edge bg-panel/80 shadow-panel">
          {selected.size > 0 && (
            <div className="flex animate-fade-up items-center gap-2 border-b border-edge bg-violet-500/[0.06] px-4 py-2 text-xs">
              <span className="font-medium text-fg">{selected.size} selected</span>
              <span className="flex-1" />
              {selectedStoppable.length > 0 && (
                <button onClick={() => void actions.stop(selectedStoppable)} className="btn-secondary h-7 gap-1.5 rounded-lg px-2.5 text-xs">
                  <Square className="h-3 w-3 fill-current" /> Stop {selectedStoppable.length}
                </button>
              )}
              <button onClick={() => void actions.remove([...selected]).then((ok) => ok && setSelected(new Set()))} className="btn-danger h-7 gap-1.5 rounded-lg px-2.5 text-xs">
                <Trash2 className="h-3.5 w-3.5" /> Delete
              </button>
              <button onClick={() => setSelected(new Set())} className="btn-icon h-7 w-7" aria-label="Clear selection" title="Clear selection">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          {all.length === 0 ? (
            <div className="p-12 text-center">
              <Inbox className="mx-auto mb-3 h-8 w-8 text-fg-muted" />
              <p className="font-medium text-fg">No incidents yet</p>
              <p className="mt-1 text-sm text-fg-muted">Report one with “New incident” or send an alert to the webhook.</p>
            </div>
          ) : rows.length === 0 ? (
            <p className="p-10 text-center text-sm text-fg-muted">No incidents match these filters.</p>
          ) : (
            <IncidentTable
              rows={rows}
              repos={repos}
              actions={actions}
              onOpen={(id) => navigate(`#/incidents/${id}`)}
              onRowClick={(id) => setActive((a) => (a === id ? null : id))}
              activeId={active}
              selection={{ selected, toggle, toggleAll }}
            />
          )}

          {visible.length > 0 && (
            <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-edge px-4 py-3 text-xs text-fg-muted">
              <span>
                Showing {(current - 1) * pageSize + 1}–{Math.min(current * pageSize, visible.length)} of {visible.length} incident{visible.length === 1 ? '' : 's'}
              </span>
              <nav className="flex items-center gap-1" aria-label="Pagination">
                <button onClick={() => setPage(current - 1)} disabled={current === 1} className="btn-icon h-8 w-8" aria-label="Previous page">
                  <ChevronLeft className="h-4 w-4" />
                </button>
                {Array.from({ length: pages }, (_, k) => k + 1)
                  .filter((p) => p === 1 || p === pages || Math.abs(p - current) <= 1)
                  .map((p, k, arr) => (
                    <span key={p} className="flex items-center">
                      {k > 0 && p - arr[k - 1] > 1 && <span className="px-1">…</span>}
                      <button
                        onClick={() => setPage(p)}
                        aria-current={p === current ? 'page' : undefined}
                        className={`h-8 min-w-[32px] rounded-lg px-2 tabular-nums transition ${p === current ? 'bg-violet-500 text-white' : 'border border-edge text-fg-soft hover:bg-panel-3'}`}
                      >
                        {p}
                      </button>
                    </span>
                  ))}
                <button onClick={() => setPage(current + 1)} disabled={current === pages} className="btn-icon h-8 w-8" aria-label="Next page">
                  <ChevronRight className="h-4 w-4" />
                </button>
              </nav>
            </footer>
          )}
        </section>
      </div>

      {active && <IncidentDrawer key={active} id={active} onClose={() => setActive(null)} navigate={navigate} />}
    </div>
  );
}
