import { ExternalLink, FolderGit2, GitBranch, Lock } from 'lucide-react';
import { Dot, PageHeader, RepoIcon, Spinner } from '@/components/ui';
import { approvable, isOpen, useData } from '@/lib/data';
import { repositories, useHealth } from '@/lib/health';

/** Repositories configured in backend/.env, with their incident numbers. */
export function Repositories() {
  const { health, down } = useHealth();
  const { incidents } = useData();
  const repos = repositories(health);

  if (!health) return down ? <p className="text-sm text-rose-300">Backend unreachable.</p> : <Spinner label="Loading…" />;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Repositories"
        subtitle={
          <>
            Where Nagent reads code and opens pull/merge requests. Add more with <code className="font-mono text-fg-soft">GITHUB_*_N</code> /{' '}
            <code className="font-mono text-fg-soft">GITLAB_*_N</code> in backend/.env.
          </>
        }
      />
      {health.github.mode === 'mock' && <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100">Mock repository mode — PRs are created in memory, not on GitHub.</p>}
      {repos.length === 0 && health.github.mode !== 'mock' && (
        <div className="rounded-xl border border-dashed border-edge-strong bg-panel/60 p-12 text-center">
          <FolderGit2 className="mx-auto mb-3 h-8 w-8 text-fg-muted" />
          <p className="font-medium text-fg">No repository configured</p>
          <p className="mt-1 text-sm text-fg-muted">Missing: {health.github.missing.join(', ')}</p>
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
        {repos.map((r) => {
          const mine = (incidents ?? []).filter((i) => i.repoTarget === r.id);
          const stats = [
            { label: 'Incidents', value: mine.length, href: `#/incidents?repo=${r.id}` },
            { label: 'Open', value: mine.filter(isOpen).length, href: `#/incidents?repo=${r.id}&view=open` },
            { label: 'Awaiting approval', value: mine.filter(approvable).length, href: `#/incidents?repo=${r.id}&status=awaiting_approval` },
            { label: 'PRs created', value: mine.filter((i) => i.prUrl).length, href: `#/incidents?repo=${r.id}&status=pr_created` },
          ];
          const paths = r.allowedPaths ?? [];
          return (
            <section key={r.id} className="flex flex-col rounded-xl border border-edge bg-panel/80 p-5 shadow-panel">
              <div className="mb-4 flex items-start gap-3">
                <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-panel-3 ring-1 ring-edge">
                  <RepoIcon provider={r.provider} className="h-5 w-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-fg" title={r.name}>{r.name}</p>
                  <p className="flex flex-wrap items-center gap-x-3 text-xs text-fg-muted">
                    <span>{r.provider === 'gitlab' ? 'GitLab' : 'GitHub'}</span>
                    <span className="flex items-center gap-1">
                      <GitBranch className="h-3 w-3" /> {r.baseBranch ?? 'main'}
                    </span>
                    <span className="font-mono">id: {r.id}</span>
                  </p>
                </div>
                <span className="flex items-center gap-1.5 text-xs text-fg-soft">
                  <Dot tone="ok" /> Connected
                </span>
              </div>
              <div className="mb-4 grid grid-cols-4 gap-2">
                {stats.map((s) => (
                  <a key={s.label} href={s.href} className="rounded-lg border border-edge bg-panel-2/50 px-2 py-2 text-center transition hover:border-edge-strong hover:bg-panel-2">
                    <span className="block font-display text-lg font-semibold tabular-nums text-fg">{s.value}</span>
                    <span className="block truncate text-[10px] text-fg-muted">{s.label}</span>
                  </a>
                ))}
              </div>
              <p className="mb-1 flex items-center gap-1.5 text-xs text-fg-muted">
                <Lock className="h-3 w-3" /> Paths Nagent may edit
              </p>
              <div className="mb-4 flex flex-wrap gap-1.5">
                {paths.length === 0 || paths.includes('*') ? (
                  <span className="rounded-md bg-panel-3 px-2 py-0.5 font-mono text-[11px] text-fg-soft">whole repository</span>
                ) : (
                  paths.map((p) => (
                    <span key={p} className="rounded-md bg-panel-3 px-2 py-0.5 font-mono text-[11px] text-fg-soft">
                      {p}
                    </span>
                  ))
                )}
              </div>
              <div className="mt-auto flex flex-wrap gap-2">
                <a href={`#/incidents?repo=${r.id}`} className="btn-secondary h-8 flex-1 text-xs">
                  View incidents
                </a>
                {r.webUrl && (
                  <a href={r.webUrl} target="_blank" rel="noopener noreferrer" className="btn-secondary h-8 flex-1 text-xs">
                    Open repository <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                )}
              </div>
              {r.isDefault && <p className="mt-3 text-[11px] text-violet-300">Default for alerts and incidents that do not choose a repository.</p>}
            </section>
          );
        })}
      </div>
    </div>
  );
}
