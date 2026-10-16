import { useMemo, useState } from 'react';
import {
  CircleCheck, CircleX, Clock3, ClipboardCheck, GitPullRequest, Hourglass, OctagonAlert, Plus, RefreshCw, ScrollText, Timer, TriangleAlert,
} from 'lucide-react';
import { useIncidentActions } from '@/components/actions';
import { IncidentTable } from '@/components/IncidentTable';
import { ServiceIcon } from '@/components/layout';
import { Select } from '@/components/menu';
import { TrendChart } from '@/components/TrendChart';
import { Delta, ErrorBox, PageHeader, Panel, Spinner, StatCard } from '@/components/ui';
import { approvalDecisions, approvable, DAY, isOpen, meanTimeToFix, useData } from '@/lib/data';
import { age, timeAgo } from '@/lib/format';
import { repositories, useHealth } from '@/lib/health';

function formatMinutes(ms: number | null): { value: string; unit: string } {
  if (ms === null) return { value: '—', unit: '' };
  const min = ms / 60_000;
  if (min < 60) return { value: String(Math.max(1, Math.round(min))), unit: 'min' };
  if (min < 60 * 48) return { value: (min / 60).toFixed(1), unit: 'h' };
  return { value: (min / 1440).toFixed(1), unit: 'd' };
}


export function Overview({ navigate, onReport }: { navigate: (hash: string) => void; onReport: () => void }) {
  const { scoped, error, updatedAt, refresh, refreshAudit, audit, environment } = useData();
  const { health } = useHealth();
  const repos = repositories(health);
  const actions = useIncidentActions();
  const [range, setRange] = useState<'7' | '14' | '30'>('7');
  const [refreshing, setRefreshing] = useState(false);

  const now = updatedAt ?? Date.now();
  const list = useMemo(() => scoped ?? [], [scoped]);
  const ids = useMemo(() => new Set(list.map((i) => i.id)), [list]);
  const since = (t?: string) => Boolean(t) && now - Date.parse(t!) < DAY;

  const open = list.filter(isOpen);
  const critical = open.filter((i) => i.severity === 'critical');
  const pending = list.filter(approvable);
  const prs = list.filter((i) => i.prUrl);
  const oldestPending = pending.reduce<string | undefined>((min, i) => (!min || i.updatedAt < min ? i.updatedAt : min), undefined);
  const mttr = meanTimeToFix(list, now - 7 * DAY, now + 1);
  const mttrBefore = meanTimeToFix(list, now - 14 * DAY, now - 7 * DAY);
  const mttrChange = mttr !== null && mttrBefore ? Math.round(((mttr - mttrBefore) / mttrBefore) * 100) : null;
  const mttrText = formatMinutes(mttr);

  // Approval decisions come from the audit trail (limited to incidents in the chosen environment).
  const decisions = approvalDecisions(audit).filter((e) => environment === 'all' || ids.has(e.incidentId));
  const approved24 = decisions.filter((e) => e.approved && since(e.at)).length;
  const rejected24 = decisions.filter((e) => !e.approved && since(e.at)).length;

  const services = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of list) m.set(i.service || 'unspecified', (m.get(i.service || 'unspecified') ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  }, [list]);

  const recent = [...open].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 7);

  const reload = async () => {
    setRefreshing(true);
    await Promise.all([refresh(), refreshAudit()]);
    setRefreshing(false);
  };

  if (!scoped) return error ? <ErrorBox message={error} onRetry={() => void refresh()} /> : <Spinner label="Loading…" />;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Overview"
        subtitle="AI-powered SRE for faster incident resolution — with human approval."
        right={
          <>
            {updatedAt && (
              <span className="flex items-center gap-2 text-xs text-fg-muted">
                <Clock3 className="h-4 w-4" />
                <span>
                  Last updated
                  <br />
                  <span className="text-fg-soft">{new Date(updatedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span>
                </span>
              </span>
            )}
            <button onClick={() => void reload()} className="btn-icon h-9 w-9" aria-label="Refresh" title="Refresh">
              <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
            </button>
          </>
        }
      />

      {error && <ErrorBox message={error} onRetry={() => void refresh()} />}

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
        <StatCard
          label="Open incidents"
          value={open.length}
          icon={<TriangleAlert className="h-5 w-5" />}
          tint="bg-sky-500/20 text-sky-200 ring-1 ring-sky-500/40"
          foot={<Delta value={list.filter((i) => since(i.createdAt)).length} label="new in last 24h" />}
          onClick={() => navigate('#/incidents?view=open')}
        />
        <StatCard
          label="Critical"
          value={critical.length}
          icon={<OctagonAlert className="h-5 w-5" />}
          tint="bg-rose-500/20 text-rose-200 ring-1 ring-rose-500/40"
          foot={<Delta value={list.filter((i) => i.severity === 'critical' && since(i.createdAt)).length} label="new in last 24h" />}
          onClick={() => navigate('#/incidents?view=critical')}
        />
        <StatCard
          label="Awaiting approval"
          value={pending.length}
          icon={<Hourglass className="h-5 w-5" />}
          tint="bg-amber-500/20 text-amber-200 ring-1 ring-amber-500/40"
          foot={oldestPending ? `oldest waiting ${age(oldestPending)}` : 'queue is empty'}
          onClick={() => navigate('#/approvals')}
        />
        <StatCard
          label="PRs created"
          value={prs.length}
          icon={<GitPullRequest className="h-5 w-5" />}
          tint="bg-emerald-500/20 text-emerald-200 ring-1 ring-emerald-500/40"
          foot={<Delta value={list.filter((i) => since(i.fixedAt)).length} goodWhenUp label="in last 24h" />}
          onClick={() => navigate('#/incidents?status=pr_created')}
        />
        <StatCard
          label="Mean time to fix (7 days)"
          value={
            <>
              {mttrText.value}
              <span className="ml-1 text-base font-semibold text-fg-soft">{mttrText.unit}</span>
            </>
          }
          icon={<Timer className="h-5 w-5" />}
          tint="bg-violet-500/20 text-violet-200 ring-1 ring-violet-500/40"
          foot={mttrChange !== null ? <Delta value={mttrChange} suffix="%" label="vs previous 7 days" /> : 'report → PR opened or resolved'}
        />
      </section>

      <div className="grid gap-5 min-[1700px]:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-5">
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
            <Panel
              title="Incident trend"
              right={
                <Select
                  ariaLabel="Trend range"
                  align="right"
                  value={range}
                  onChange={setRange}
                  className="h-8"
                  panelClassName="w-40"
                  options={[
                    { value: '7', label: 'Last 7 days' },
                    { value: '14', label: 'Last 14 days' },
                    { value: '30', label: 'Last 30 days' },
                  ]}
                />
              }
            >
              <TrendChart incidents={list} days={Number(range)} />
            </Panel>

            <Panel
              title="Approval queue"
              right={<span className="rounded-full bg-panel-3 px-2.5 py-1 text-xs text-fg-soft ring-1 ring-edge">{pending.length} pending</span>}
              bodyClassName="p-3"
            >
              {[
                { label: 'Awaiting approval', value: pending.length, icon: <Hourglass className="h-4 w-4" />, tint: 'bg-amber-500/20 text-amber-200', href: '#/approvals' },
                { label: 'Approved (last 24h)', value: approved24, icon: <CircleCheck className="h-4 w-4" />, tint: 'bg-emerald-500/20 text-emerald-200', href: '#/approvals?tab=history' },
                { label: 'Rejected (last 24h)', value: rejected24, icon: <CircleX className="h-4 w-4" />, tint: 'bg-rose-500/20 text-rose-200', href: '#/approvals?tab=history' },
              ].map((r) => (
                <a key={r.label} href={r.href} className="flex items-center gap-3 rounded-lg px-2 py-3 transition hover:bg-panel-2">
                  <span className={`flex h-8 w-8 items-center justify-center rounded-full ${r.tint}`}>{r.icon}</span>
                  <span className="flex-1 text-sm text-fg-soft">{r.label}</span>
                  <span className="font-display text-lg font-semibold tabular-nums text-fg">{r.value}</span>
                </a>
              ))}
            </Panel>
          </div>

          <Panel
            title={
              <>
                Incidents <span className="ml-2 text-xs font-normal text-fg-muted">{open.length} open</span>
              </>
            }
            right={
              <a href="#/incidents" className="text-xs text-violet-300 hover:underline">
                View all →
              </a>
            }
            bodyClassName="pt-2"
          >
            {recent.length ? (
              <IncidentTable rows={recent} repos={repos} actions={actions} onOpen={(id) => navigate(`#/incidents/${id}`)} compact />
            ) : (
              <p className="px-5 pb-8 pt-4 text-center text-sm text-fg-muted">No open incidents{environment !== 'all' ? ` in ${environment}` : ''}.</p>
            )}
          </Panel>
        </div>

        <div className="grid items-start gap-5 md:grid-cols-2 xl:grid-cols-3 min-[1700px]:grid-cols-1">
          <Panel
            title="Recent approvals"
            right={
              <a href="#/approvals?tab=history" className="text-xs text-violet-300 hover:underline">
                View all →
              </a>
            }
            bodyClassName="p-3"
          >
            {decisions.length === 0 && <p className="px-2 py-6 text-center text-sm text-fg-muted">No approval decisions yet.</p>}
            {decisions.slice(0, 5).map((e, k) => {
              const ok = e.approved;
              return (
                <a
                  key={k}
                  href={e.exists ? `#/incidents/${e.incidentId}` : undefined}
                  className="flex gap-3 rounded-lg px-2 py-2.5 transition hover:bg-panel-2"
                >
                  {ok ? <CircleCheck className="mt-0.5 h-5 w-5 flex-shrink-0 text-emerald-400" /> : <CircleX className="mt-0.5 h-5 w-5 flex-shrink-0 text-rose-400" />}
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span
                        className={`rounded-full px-2 py-px text-[10px] font-semibold ring-1 ${ok ? 'bg-emerald-500/15 text-emerald-200 ring-emerald-500/40' : 'bg-rose-500/15 text-rose-200 ring-rose-500/40'}`}
                      >
                        {ok ? 'Approved' : 'Rejected'}
                      </span>
                      <span className="truncate font-mono text-[11px] text-fg-muted">#{e.incidentId}</span>
                      <span className="ml-auto flex-shrink-0 text-[11px] text-fg-muted">{timeAgo(e.at)}</span>
                    </span>
                    <span className="mt-1 block truncate text-sm text-fg-soft">{e.incidentTitle}</span>
                    {e.actor && <span className="block text-[11px] text-fg-muted">by {e.actor}</span>}
                  </span>
                </a>
              );
            })}
          </Panel>

          <Panel title="Top services by incidents" bodyClassName="px-5 pb-4 pt-3">
            {services.length === 0 && <p className="py-4 text-center text-sm text-fg-muted">No incidents yet.</p>}
            <ul className="space-y-3">
              {services.map(([name, count]) => (
                <li key={name}>
                  <a href={name === 'unspecified' ? '#/services' : `#/incidents?service=${encodeURIComponent(name)}`} className="group block">
                    <span className="mb-1.5 flex items-center gap-2.5 text-sm">
                      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-panel-3 ring-1 ring-edge">
                        <ServiceIcon name={name} />
                      </span>
                      <span className="flex-1 truncate text-fg-soft group-hover:text-fg">{name}</span>
                      <span className="tabular-nums text-fg">{count}</span>
                    </span>
                    <span className="ml-[38px] block h-1.5 overflow-hidden rounded-full bg-panel-3">
                      <span className="block h-full rounded-full bg-gradient-to-r from-violet-500 to-cyan-400" style={{ width: `${(count / services[0][1]) * 100}%` }} />
                    </span>
                  </a>
                </li>
              ))}
            </ul>
            <a href="#/services" className="mt-4 inline-block text-xs text-violet-300 hover:underline">
              View all services →
            </a>
          </Panel>

          <Panel title="Quick actions" bodyClassName="p-3">
            {[
              { label: 'Create new incident', hint: 'Manually report an incident', icon: Plus, onClick: onReport },
              { label: 'View approval queue', hint: 'Review pending changes', icon: ClipboardCheck, onClick: () => navigate('#/approvals') },
              { label: 'Open audit log', hint: 'Track all actions and approvals', icon: ScrollText, onClick: () => navigate('#/audit') },
            ].map((q) => (
              <button key={q.label} onClick={q.onClick} className="flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left transition hover:bg-panel-2">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-panel-3 text-fg-soft ring-1 ring-edge">
                  <q.icon className="h-4 w-4" />
                </span>
                <span>
                  <span className="block text-sm text-fg">{q.label}</span>
                  <span className="block text-xs text-fg-muted">{q.hint}</span>
                </span>
              </button>
            ))}
          </Panel>
        </div>
      </div>
    </div>
  );
}
