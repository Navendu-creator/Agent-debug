import { useMemo, useState } from 'react';
import { ArrowUpDown, Search } from 'lucide-react';
import { ServiceIcon } from '@/components/layout';
import { Select } from '@/components/menu';
import { ErrorBox, PageHeader, SEVERITIES, SEVERITY_COLOR, SEVERITY_LABEL, Spinner } from '@/components/ui';
import type { Severity } from '@/lib/api';
import { isOpen, useData } from '@/lib/data';
import { timeAgo } from '@/lib/format';

interface ServiceRow {
  name: string;
  total: number;
  open: number;
  prs: number;
  bySeverity: Record<Severity, number>;
  environments: string[];
  last: string;
}

type Sort = 'total' | 'open' | 'recent' | 'name';

/** Services derived from the `service` field of incidents. */
export function Services() {
  const { scoped, error, refresh } = useData();
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<Sort>('total');

  const rows = useMemo(() => {
    const m = new Map<string, ServiceRow>();
    for (const i of scoped ?? []) {
      const name = i.service || 'unspecified';
      const r = m.get(name) ?? { name, total: 0, open: 0, prs: 0, bySeverity: { critical: 0, high: 0, medium: 0, low: 0 }, environments: [], last: i.createdAt };
      r.total++;
      if (isOpen(i)) r.open++;
      if (i.prUrl) r.prs++;
      r.bySeverity[i.severity]++;
      if (i.environment && !r.environments.includes(i.environment)) r.environments.push(i.environment);
      if (i.createdAt > r.last) r.last = i.createdAt;
      m.set(name, r);
    }
    const list = [...m.values()].filter((r) => r.name.toLowerCase().includes(q.trim().toLowerCase()));
    const cmp: Record<Sort, (a: ServiceRow, b: ServiceRow) => number> = {
      total: (a, b) => b.total - a.total,
      open: (a, b) => b.open - a.open || b.total - a.total,
      recent: (a, b) => b.last.localeCompare(a.last),
      name: (a, b) => a.name.localeCompare(b.name),
    };
    return list.sort(cmp[sort]);
  }, [scoped, q, sort]);

  if (!scoped) return error ? <ErrorBox message={error} onRetry={() => void refresh()} /> : <Spinner label="Loading…" />;
  const max = Math.max(1, ...rows.map((r) => r.total));

  return (
    <div className="space-y-5">
      <PageHeader title="Services" subtitle="Incidents grouped by the service they were reported for." />
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-[220px] flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search services…" className="field h-9 py-0 pl-9" />
        </label>
        <Select
          ariaLabel="Sort services"
          value={sort}
          onChange={setSort}
          prefix={<ArrowUpDown className="h-3.5 w-3.5 text-fg-muted" />}
          options={[
            { value: 'total', label: 'Most incidents' },
            { value: 'open', label: 'Most open' },
            { value: 'recent', label: 'Most recent' },
            { value: 'name', label: 'Name' },
          ]}
        />
        <ul className="ml-auto flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-soft" aria-label="Severity legend">
          {SEVERITIES.map((s) => (
            <li key={s} className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: SEVERITY_COLOR[s] }} /> {SEVERITY_LABEL[s]}
            </li>
          ))}
        </ul>
      </div>

      <section className="overflow-hidden rounded-xl border border-edge bg-panel/80 shadow-panel">
        {rows.length === 0 ? (
          <p className="p-10 text-center text-sm text-fg-muted">No services found.</p>
        ) : (
          <div className="scrollbar-thin overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="border-b border-edge text-xs text-fg-muted">
                <tr>
                  <th className="px-5 py-3 text-left font-medium">Service</th>
                  <th className="px-3 py-3 text-left font-medium">Incidents by severity</th>
                  <th className="px-3 py-3 text-right font-medium">Total</th>
                  <th className="px-3 py-3 text-right font-medium">Open</th>
                  <th className="px-3 py-3 text-right font-medium">PRs</th>
                  <th className="px-3 py-3 text-left font-medium">Environments</th>
                  <th className="px-5 py-3 text-right font-medium">Last incident</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-edge">
                {rows.map((r) => (
                  <tr key={r.name} className="transition hover:bg-panel-2/70">
                    <td className="px-5 py-3">
                      <a
                        href={r.name === 'unspecified' ? '#/incidents' : `#/incidents?service=${encodeURIComponent(r.name)}`}
                        className="flex items-center gap-2.5 font-medium text-fg hover:text-white"
                      >
                        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-panel-3 ring-1 ring-edge">
                          <ServiceIcon name={r.name} />
                        </span>
                        {r.name === 'unspecified' ? <span className="italic text-fg-muted">No service set</span> : r.name}
                      </a>
                    </td>
                    <td className="px-3 py-3">
                      {/* stacked bar with 2px surface gaps between segments */}
                      <div
                        className="flex h-2 gap-[2px] overflow-hidden rounded-full"
                        style={{ width: `${Math.max(8, (r.total / max) * 100)}%` }}
                        title={SEVERITIES.map((s) => `${SEVERITY_LABEL[s]}: ${r.bySeverity[s]}`).join(' · ')}
                      >
                        {SEVERITIES.filter((s) => r.bySeverity[s]).map((s) => (
                          <span key={s} style={{ flex: r.bySeverity[s], background: SEVERITY_COLOR[s] }} />
                        ))}
                      </div>
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums text-fg">{r.total}</td>
                    <td className="px-3 py-3 text-right tabular-nums text-fg-soft">{r.open}</td>
                    <td className="px-3 py-3 text-right tabular-nums text-fg-soft">{r.prs}</td>
                    <td className="px-3 py-3 text-xs text-fg-soft">{r.environments.join(', ') || '—'}</td>
                    <td className="px-5 py-3 text-right text-xs text-fg-muted" title={new Date(r.last).toLocaleString()}>
                      {timeAgo(r.last)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
