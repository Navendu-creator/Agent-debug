import { MoreHorizontal, Square } from 'lucide-react';
import type { IncidentSummary } from '@/lib/api';
import { shortRepo, stoppable } from '@/lib/data';
import { timeAgo } from '@/lib/format';
import type { Repository } from '@/lib/health';
import { incidentMenuItems, type IncidentActions } from './actions';
import { ServiceIcon } from './layout';
import { Menu } from './menu';
import { Avatar, ConfidenceBar, RepoIcon, SeverityBadge, StatusBadge } from './ui';


/**
 * Incident rows as a table. `selection` adds checkboxes; `activeId` highlights the row shown in the
 * side panel; `compact` drops columns for the overview page.
 */
export function IncidentTable({
  rows,
  repos,
  actions,
  onOpen,
  onRowClick,
  activeId,
  selection,
  compact,
}: {
  rows: IncidentSummary[];
  repos: Repository[];
  actions: IncidentActions;
  onOpen: (id: string) => void;
  onRowClick?: (id: string) => void;
  activeId?: string | null;
  selection?: { selected: Set<string>; toggle: (id: string) => void; toggleAll: () => void };
  compact?: boolean;
}) {
  const repoOf = (i: IncidentSummary) => repos.find((r) => r.id === i.repoTarget);
  const pad = compact ? 'px-2' : 'px-3';
  const th = `whitespace-nowrap ${pad} py-3 text-left text-xs font-medium text-fg-muted`;
  const td = `${pad} py-3 align-middle`;
  const narrow = compact ? 'max-w-[120px]' : 'max-w-[140px]';
  const allSelected = selection && rows.length > 0 && rows.every((r) => selection.selected.has(r.id));
  const someSelected = selection && rows.some((r) => selection.selected.has(r.id));

  return (
    <div className="scrollbar-thin overflow-x-auto">
      <table className={`w-full border-collapse text-sm ${compact ? 'min-w-[860px]' : 'min-w-[960px]'}`}>
        <thead className="border-b border-edge">
          <tr>
            {selection && (
              <th className="w-10 py-3 pl-4 pr-1">
                <input
                  type="checkbox"
                  className="checkbox"
                  aria-label="Select all incidents on this page"
                  checked={Boolean(allSelected)}
                  ref={(el) => {
                    if (el) el.indeterminate = Boolean(someSelected && !allSelected);
                  }}
                  onChange={selection.toggleAll}
                  disabled={!rows.length}
                />
              </th>
            )}
            <th className={`${th} ${selection ? '' : 'pl-5'}`}>Severity</th>
            <th className={th}>{compact ? 'Incident title' : 'Incident summary'}</th>
            <th className={th}>{compact ? 'Service / Environment' : 'Service'}</th>
            <th className={th}>Repository</th>
            {!compact && <th className={th}>Environment</th>}
            {compact && <th className={th}>Owner</th>}
            <th className={th}>Status</th>
            <th className={th}>Confidence</th>
            <th className={th}>Updated</th>
            {!compact && <th className={th}>Owner</th>}
            <th className={`${th} pr-5 text-right`}>Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-edge">
          {rows.map((i) => {
            const repo = repoOf(i);
            const active = activeId === i.id;
            const selected = selection?.selected.has(i.id);
            return (
              <tr
                key={i.id}
                onClick={(e) => {
                  if ((e.target as HTMLElement).closest('button,a,input,[role=menu]')) return;
                  (onRowClick ?? onOpen)(i.id);
                }}
                className={`cursor-pointer transition ${
                  active ? 'bg-violet-500/10 outline outline-1 -outline-offset-1 outline-violet-500/60' : selected ? 'bg-violet-500/[0.06]' : 'hover:bg-panel-2/70'
                }`}
              >
                {selection && (
                  <td className="py-3 pl-4 pr-1">
                    <input type="checkbox" className="checkbox" checked={Boolean(selected)} onChange={() => selection.toggle(i.id)} aria-label={`Select ${i.id}`} />
                  </td>
                )}
                <td className={`${td} ${selection ? '' : 'pl-5'}`}>
                  <SeverityBadge severity={i.severity} />
                </td>
                <td className={`${td} ${compact ? 'max-w-[220px]' : 'max-w-[300px]'}`}>
                  <a
                    href={`#/incidents/${i.id}`}
                    onClick={(e) => {
                      if (e.metaKey || e.ctrlKey) return;
                      e.preventDefault();
                      (onRowClick ?? onOpen)(i.id);
                    }}
                    className="block truncate font-medium text-fg hover:text-white"
                    title={i.title}
                  >
                    {i.title}
                  </a>
                  <p className="truncate text-xs text-fg-muted" title={i.snippet}>
                    {compact ? (
                      <span className="font-mono">
                        #{i.id} · {i.source}
                      </span>
                    ) : (
                      i.snippet || <span className="font-mono">#{i.id} · {i.source}</span>
                    )}
                  </p>
                </td>
                <td className={td}>
                  <span className="flex items-center gap-2">
                    <ServiceIcon name={i.service} />
                    <span className="min-w-0">
                      <span className={`block ${narrow} truncate text-fg-soft`}>{i.service || '—'}</span>
                      {compact && <span className="block text-xs text-fg-muted">{i.environment || '—'}</span>}
                    </span>
                  </span>
                </td>
                <td className={td}>
                  {repo ? (
                    <span className="flex items-center gap-2 text-fg-soft" title={repo.name}>
                      <RepoIcon provider={repo.provider} className="h-4 w-4" />
                      <span className={`${narrow} truncate`}>{shortRepo(repo.name)}</span>
                    </span>
                  ) : (
                    <span className="text-xs text-fg-muted">{i.repoTarget ?? '—'}</span>
                  )}
                </td>
                {!compact && <td className={`${td} text-fg-soft`}>{i.environment || '—'}</td>}
                {compact && <td className={td}>{i.owner ? <Avatar name={i.owner} /> : <span className="text-xs text-fg-muted" title="Unassigned">—</span>}</td>}
                <td className={td}>
                  <div className="flex items-center gap-1.5">
                    <StatusBadge status={i.status} />
                    {i.analysisMode === 'demo' && <span className="rounded bg-amber-500/15 px-1.5 text-[10px] font-semibold text-amber-200">DEMO</span>}
                  </div>
                </td>
                <td className={td}>
                  {i.status === 'investigating' ? <span className="text-xs text-sky-300">Analyzing…</span> : <ConfidenceBar value={i.confidence} />}
                </td>
                <td className={`${td} whitespace-nowrap text-xs text-fg-muted`} title={new Date(i.updatedAt).toLocaleString()}>
                  {timeAgo(i.updatedAt)}
                </td>
                {!compact && <td className={td}>{i.owner ? <OwnerCell name={i.owner} /> : <span className="text-xs text-fg-muted">—</span>}</td>}
                <td className={`${td} pr-4`}>
                  <div className="flex items-center justify-end gap-1">
                    {stoppable(i) && (
                      <button onClick={() => void actions.stop([i.id])} className="btn-danger h-7 gap-1 rounded-lg px-2 text-xs" title="Stop analysis">
                        <Square className="h-3 w-3 fill-current" /> Stop
                      </button>
                    )}
                    {compact && (
                      <button onClick={() => onOpen(i.id)} className="btn-secondary h-7 rounded-lg px-3 text-xs">
                        View
                      </button>
                    )}
                    <Menu
                      ariaLabel={`Actions for ${i.id}`}
                      title="Actions"
                      buttonClassName="btn-icon"
                      panelClassName="w-60"
                      button={<MoreHorizontal className="h-4 w-4" />}
                      items={incidentMenuItems(i, actions, () => onOpen(i.id))}
                    />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function OwnerCell({ name }: { name: string }) {
  return (
    <span className="flex items-center gap-2">
      <Avatar name={name} />
      <span className="max-w-[90px] truncate text-xs text-fg-soft">{name}</span>
    </span>
  );
}
