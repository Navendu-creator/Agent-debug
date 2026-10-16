import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, RefreshCw, Search } from 'lucide-react';
import { MultiSelect, Select } from '@/components/menu';
import { Avatar, PageHeader, Spinner } from '@/components/ui';
import { DAY, useData } from '@/lib/data';
import { downloadFile } from '@/lib/format';

const TYPES: Array<{ value: string; label: string; dot: string }> = [
  { value: 'approval', label: 'Approval', dot: 'bg-amber-400' },
  { value: 'status', label: 'Status change', dot: 'bg-teal-400' },
  { value: 'pr', label: 'Pull request', dot: 'bg-emerald-400' },
  { value: 'analysis', label: 'Analysis', dot: 'bg-violet-400' },
  { value: 'patch', label: 'Patch', dot: 'bg-fuchsia-400' },
  { value: 'validation', label: 'Validation', dot: 'bg-cyan-400' },
  { value: 'repo', label: 'Repository', dot: 'bg-sky-400' },
  { value: 'notify', label: 'Notification', dot: 'bg-blue-400' },
  { value: 'intake', label: 'Intake', dot: 'bg-slate-300' },
  { value: 'info', label: 'Info', dot: 'bg-slate-400' },
  { value: 'error', label: 'Error', dot: 'bg-rose-400' },
];

type Range = 'all' | '24h' | '7d' | '30d';
const PAGE = 50;

const csvCell = (v: string) => `"${v.replace(/"/g, '""')}"`;

/** Every event across incidents (and deleted ones), filterable and exportable. */
export function AuditLog() {
  const { audit, refreshAudit } = useData();
  const [q, setQ] = useState('');
  const [types, setTypes] = useState<string[]>([]);
  const [actorsOnly, setActorsOnly] = useState<'all' | 'people'>('all');
  const [range, setRange] = useState<Range>('all');
  const [page, setPage] = useState(1);
  const [refreshing, setRefreshing] = useState(false);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const since = range === 'all' ? 0 : Date.now() - (range === '24h' ? DAY : range === '7d' ? 7 * DAY : 30 * DAY);
    return (audit ?? []).filter(
      (e) =>
        (!types.length || types.includes(e.type)) &&
        (actorsOnly === 'all' || Boolean(e.actor)) &&
        Date.parse(e.at) >= since &&
        (!needle || [e.message, e.incidentId, e.incidentTitle, e.actor ?? ''].some((v) => v.toLowerCase().includes(needle))),
    );
  }, [audit, q, types, actorsOnly, range]);

  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const current = Math.min(page, pages);
  const shown = rows.slice((current - 1) * PAGE, current * PAGE);

  const exportCsv = () => {
    const lines = [
      ['time', 'incident', 'title', 'type', 'actor', 'message', 'incident_deleted'].join(','),
      ...rows.map((e) => [e.at, e.incidentId, e.incidentTitle, e.type, e.actor ?? '', e.message, String(!e.exists)].map(csvCell).join(',')),
    ];
    downloadFile(`nagent-audit-${new Date().toISOString().slice(0, 10)}.csv`, lines.join('\n'), 'text/csv');
  };

  const reload = async () => {
    setRefreshing(true);
    await refreshAudit();
    setRefreshing(false);
  };

  if (!audit) return <Spinner label="Loading audit log…" />;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Audit log"
        subtitle="Everything Nagent and its operators did, newest first. Events of deleted incidents are kept."
        right={
          <>
            <button onClick={() => void reload()} className="btn-icon h-9 w-9" aria-label="Refresh" title="Refresh">
              <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
            </button>
            <button onClick={exportCsv} disabled={!rows.length} className="btn-secondary h-9 text-xs">
              <Download className="h-4 w-4" /> Export CSV
            </button>
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-[220px] flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted" />
          <input
            value={q}
            onChange={(e) => (setQ(e.target.value), setPage(1))}
            placeholder="Search message, incident, actor…"
            className="field h-9 py-0 pl-9"
          />
        </label>
        <MultiSelect label="Type" values={types} onChange={(v) => (setTypes(v), setPage(1))} options={TYPES.map((t) => ({ value: t.value, label: t.label, icon: <span className={`h-2 w-2 rounded-full ${t.dot}`} /> }))} />
        <Select
          ariaLabel="Actor"
          value={actorsOnly}
          onChange={(v) => (setActorsOnly(v), setPage(1))}
          options={[
            { value: 'all', label: 'People & agent' },
            { value: 'people', label: 'People only' },
          ]}
        />
        <Select
          ariaLabel="Time range"
          value={range}
          onChange={(v) => (setRange(v), setPage(1))}
          options={[
            { value: 'all', label: 'All time' },
            { value: '24h', label: 'Last 24 hours' },
            { value: '7d', label: 'Last 7 days' },
            { value: '30d', label: 'Last 30 days' },
          ]}
        />
      </div>

      <section className="overflow-hidden rounded-xl border border-edge bg-panel/80 shadow-panel">
        {shown.length === 0 ? (
          <p className="p-10 text-center text-sm text-fg-muted">No events match.</p>
        ) : (
          <div className="scrollbar-thin overflow-x-auto">
            <table className="w-full min-w-[860px] text-sm">
              <thead className="border-b border-edge text-xs text-fg-muted">
                <tr>
                  <th className="px-5 py-3 text-left font-medium">Time</th>
                  <th className="px-3 py-3 text-left font-medium">Type</th>
                  <th className="px-3 py-3 text-left font-medium">Incident</th>
                  <th className="px-3 py-3 text-left font-medium">Event</th>
                  <th className="px-5 py-3 text-left font-medium">Actor</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-edge">
                {shown.map((e, k) => {
                  const t = TYPES.find((x) => x.value === e.type);
                  return (
                    <tr key={k} className="align-top hover:bg-panel-2/60">
                      <td className="whitespace-nowrap px-5 py-2.5 font-mono text-[11px] text-fg-muted">{new Date(e.at).toLocaleString()}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-xs text-fg-soft">
                        <span className="flex items-center gap-1.5">
                          <span className={`h-2 w-2 rounded-full ${t?.dot ?? 'bg-slate-400'}`} /> {t?.label ?? e.type}
                        </span>
                      </td>
                      <td className="max-w-[220px] px-3 py-2.5">
                        {e.exists ? (
                          <a href={`#/incidents/${e.incidentId}`} className="block truncate text-xs text-fg hover:text-white" title={e.incidentTitle}>
                            {e.incidentTitle}
                          </a>
                        ) : (
                          <span className="block truncate text-xs text-fg-soft" title={e.incidentTitle}>
                            {e.incidentTitle} <span className="rounded bg-panel-3 px-1 text-[10px] text-fg-muted">deleted</span>
                          </span>
                        )}
                        <span className="font-mono text-[10px] text-fg-muted">#{e.incidentId}</span>
                      </td>
                      <td className="px-3 py-2.5 text-xs text-fg-soft">
                        <span className="line-clamp-3 break-words">{e.message}</span>
                      </td>
                      <td className="whitespace-nowrap px-5 py-2.5 text-xs">
                        {e.actor ? (
                          <span className="flex items-center gap-2 text-fg-soft">
                            <Avatar name={e.actor} size="h-6 w-6 text-[9px]" /> {e.actor}
                          </span>
                        ) : (
                          <span className="text-fg-muted">Nagent</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <footer className="flex items-center justify-between border-t border-edge px-5 py-3 text-xs text-fg-muted">
          <span>
            {rows.length} event{rows.length === 1 ? '' : 's'} · newest 500 loaded
          </span>
          {pages > 1 && (
            <span className="flex items-center gap-1">
              <button onClick={() => setPage(current - 1)} disabled={current === 1} className="btn-icon h-8 w-8" aria-label="Previous page">
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="tabular-nums">
                {current} / {pages}
              </span>
              <button onClick={() => setPage(current + 1)} disabled={current === pages} className="btn-icon h-8 w-8" aria-label="Next page">
                <ChevronRight className="h-4 w-4" />
              </button>
            </span>
          )}
        </footer>
      </section>
    </div>
  );
}
