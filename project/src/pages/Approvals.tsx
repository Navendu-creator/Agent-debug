import { useEffect, useMemo, useState } from 'react';
import { Ban, CircleCheck, CircleX, ClipboardCheck, ExternalLink, FileDiff, GitPullRequest, Loader2, ShieldCheck } from 'lucide-react';
import { useIncidentActions } from '@/components/actions';
import { ConfidenceBar, ErrorBox, PageHeader, Panel, RepoIcon, SeverityBadge, Spinner } from '@/components/ui';
import { api, type Incident } from '@/lib/api';
import { approvable, approvalDecisions, useData } from '@/lib/data';
import { age, timeAgo } from '@/lib/format';
import { repositories, useHealth } from '@/lib/health';

type Tab = 'pending' | 'history';

/** Loads the full incident (patch + checks) for each pending approval. */
function usePatches(ids: string[]) {
  const [data, setData] = useState<Record<string, Incident>>({});
  const key = ids.join(',');
  useEffect(() => {
    let cancelled = false;
    void Promise.allSettled(ids.map((id) => api.get(id))).then((results) => {
      if (cancelled) return;
      const next: Record<string, Incident> = {};
      results.forEach((r) => {
        if (r.status === 'fulfilled') next[r.value.incident.id] = r.value.incident;
      });
      setData(next);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload when the set of ids changes
  }, [key]);
  return data;
}

export function Approvals({ query, navigate }: { query: URLSearchParams; navigate: (hash: string) => void }) {
  const { scoped, audit, error, refresh } = useData();
  const { health } = useHealth();
  const repos = repositories(health);
  const actions = useIncidentActions();
  const [tab, setTab] = useState<Tab>(query.get('tab') === 'history' ? 'history' : 'pending');
  const [acting, setActing] = useState<string | null>(null);

  const pending = useMemo(() => (scoped ?? []).filter(approvable).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)), [scoped]);
  const patches = usePatches(pending.map((p) => p.id));
  const history = approvalDecisions(audit);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setActing(key);
    await fn();
    setActing(null);
  };

  if (!scoped) return error ? <ErrorBox message={error} onRetry={() => void refresh()} /> : <Spinner label="Loading…" />;

  return (
    <div className="space-y-5">
      <PageHeader title="Approvals" subtitle="Every patch Nagent proposes waits here until a person approves or rejects it." />

      <div className="flex gap-1 rounded-xl border border-edge bg-panel/70 p-1" role="tablist" style={{ width: 'max-content' }}>
        {(
          [
            ['pending', `Pending · ${pending.length}`],
            ['history', `History · ${history.length}`],
          ] as Array<[Tab, string]>
        ).map(([t, label]) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`rounded-lg px-4 py-1.5 text-sm font-medium transition ${tab === t ? 'bg-panel-3 text-fg ring-1 ring-edge-strong' : 'text-fg-muted hover:text-fg'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'pending' &&
        (pending.length === 0 ? (
          <div className="rounded-xl border border-dashed border-edge-strong bg-panel/60 p-12 text-center">
            <ShieldCheck className="mx-auto mb-3 h-8 w-8 text-emerald-400" />
            <p className="font-medium text-fg">Nothing waiting for approval</p>
            <p className="mt-1 text-sm text-fg-muted">Patches appear here after an AI investigation validates them.</p>
          </div>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {pending.map((p) => {
              const full = patches[p.id];
              const r = full?.remediation;
              const repo = repos.find((x) => x.id === p.repoTarget);
              const code = r?.changes.filter((c) => !c.path.startsWith('docs/incidents/')) ?? [];
              const passed = r?.checks.filter((c) => c.status === 'passed').length ?? 0;
              const short = r?.provider === 'gitlab' ? 'MR' : 'PR';
              return (
                <Panel
                  key={p.id}
                  title={
                    <a href={`#/incidents/${p.id}`} className="hover:text-white">
                      {p.title}
                    </a>
                  }
                  right={<SeverityBadge severity={p.severity} />}
                  bodyClassName="px-5 pb-5 pt-2"
                >
                  <p className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted">
                    <span className="font-mono">#{p.id}</span>
                    {repo && (
                      <span className="flex items-center gap-1.5">
                        <RepoIcon provider={repo.provider} className="h-3.5 w-3.5" /> {repo.name}@{repo.baseBranch ?? 'main'}
                      </span>
                    )}
                    <span>waiting {age(p.updatedAt)}</span>
                  </p>
                  <div className="mb-4 grid grid-cols-3 gap-3 rounded-lg border border-edge bg-panel-2/50 p-3 text-xs">
                    <div>
                      <p className="mb-1 text-fg-muted">Confidence</p>
                      <ConfidenceBar value={p.confidence} />
                    </div>
                    <div>
                      <p className="mb-1 text-fg-muted">Files changed</p>
                      <p className="text-sm text-fg">{r ? (code.length ? code.length : 'RCA only') : '…'}</p>
                    </div>
                    <div>
                      <p className="mb-1 text-fg-muted">Static checks</p>
                      <p className="text-sm text-fg">{r ? `${passed}/${r.checks.length} passed` : '…'}</p>
                    </div>
                  </div>
                  {code.length > 0 && (
                    <ul className="mb-4 space-y-1">
                      {code.map((c) => (
                        <li key={c.path} className="flex items-center gap-2 text-xs">
                          <FileDiff className="h-3.5 w-3.5 flex-shrink-0 text-fg-muted" />
                          <span className="truncate font-mono text-fg-soft" title={c.path}>{c.path}</span>
                          <span className="truncate text-fg-muted">— {c.description}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {full?.analysis && <p className="mb-4 line-clamp-2 text-sm text-fg-soft">{full.analysis.result.probableRootCause}</p>}
                  <div className="flex flex-wrap gap-2">
                    <button onClick={() => navigate(`#/incidents/${p.id}`)} className="btn-secondary h-9 text-xs">
                      <FileDiff className="h-4 w-4" /> Review diff
                    </button>
                    <span className="flex-1" />
                    <button onClick={() => void act(`r${p.id}`, () => actions.reject(p.id))} disabled={acting !== null} className="btn-danger h-9 text-xs">
                      {acting === `r${p.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ban className="h-4 w-4" />} Reject
                    </button>
                    <button onClick={() => void act(`a${p.id}`, () => actions.approve(p.id))} disabled={acting !== null} className="btn-primary h-9 text-xs">
                      {acting === `a${p.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <GitPullRequest className="h-4 w-4" />} Approve & create {short}
                    </button>
                  </div>
                </Panel>
              );
            })}
          </div>
        ))}

      {tab === 'history' && (
        <section className="overflow-hidden rounded-xl border border-edge bg-panel/80 shadow-panel">
          {history.length === 0 ? (
            <p className="p-10 text-center text-sm text-fg-muted">No approval decisions yet.</p>
          ) : (
            <ul className="divide-y divide-edge">
              {history.map((e, k) => {
                const ok = e.approved;
                const incident = scoped.find((i) => i.id === e.incidentId);
                return (
                  <li key={k} className="flex items-start gap-3 px-5 py-3.5">
                    {ok ? <CircleCheck className="mt-0.5 h-5 w-5 flex-shrink-0 text-emerald-400" /> : <CircleX className="mt-0.5 h-5 w-5 flex-shrink-0 text-rose-400" />}
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2 text-sm">
                        {e.exists ? (
                          <a href={`#/incidents/${e.incidentId}`} className="font-medium text-fg hover:text-white">
                            {e.incidentTitle}
                          </a>
                        ) : (
                          <span className="font-medium text-fg-soft">{e.incidentTitle}</span>
                        )}
                        <span className="font-mono text-[11px] text-fg-muted">#{e.incidentId}</span>
                        {!e.exists && <span className="rounded bg-panel-3 px-1.5 text-[10px] text-fg-muted">deleted</span>}
                      </p>
                      <p className="break-words text-xs text-fg-soft">{e.type === 'pr' ? `Approved — ${e.message}` : e.message}</p>
                    </div>
                    {incident?.prUrl && /^https:\/\//.test(incident.prUrl) && (
                      <a href={incident.prUrl} target="_blank" rel="noopener noreferrer" className="btn-icon" title="View pull request" aria-label="View pull request">
                        <ExternalLink className="h-4 w-4" />
                      </a>
                    )}
                    <span className="flex-shrink-0 text-right text-xs text-fg-muted" title={new Date(e.at).toLocaleString()}>
                      {timeAgo(e.at)}
                      {e.actor && <span className="block text-fg-soft">{e.actor}</span>}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {tab === 'pending' && pending.length > 0 && (
        <p className="flex items-center gap-2 text-xs text-fg-muted">
          <ClipboardCheck className="h-4 w-4" /> Oldest first. Approving opens a branch and pull request on the repository; nothing is merged automatically.
        </p>
      )}
    </div>
  );
}
