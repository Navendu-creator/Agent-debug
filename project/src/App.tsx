import { useEffect, useState, type ReactNode } from 'react';
import { IncidentDetail } from '@/components/IncidentDetail';
import { IncidentList } from '@/components/IncidentList';
import { Logo } from '@/components/ui';
import { api, type Health } from '@/lib/api';

function useHash(): [string, (hash: string) => void] {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return [hash, (h: string) => (window.location.hash = h)];
}

type Tone = 'ok' | 'warn' | 'off';

function Chip({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  const cls = {
    ok: 'text-emerald-200 ring-emerald-500/30 bg-emerald-500/10',
    warn: 'text-amber-200 ring-amber-500/30 bg-amber-500/10',
    off: 'text-fg-muted ring-edge bg-panel-2',
  }[tone];
  const dot = { ok: 'bg-emerald-400', warn: 'bg-amber-400', off: 'bg-fg-muted/60' }[tone];
  return (
    <span title={title} className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 ${cls}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {children}
    </span>
  );
}

function SystemStatus() {
  const [health, setHealth] = useState<Health | null>(null);
  const [down, setDown] = useState(false);

  useEffect(() => {
    const load = () =>
      api.health().then(
        (h) => {
          setHealth(h);
          setDown(false);
        },
        () => setDown(true),
      );
    void load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);

  if (down) return <Chip tone="warn">Backend unreachable</Chip>;
  if (!health) return null;
  const { ai, github, teams } = health;
  const repos = (health.repos ?? []).filter((r) => r.provider === 'github' || r.provider === 'gitlab');
  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      {ai.demoMode ? (
        <Chip tone="warn">Demo mode</Chip>
      ) : (
        <Chip tone={ai.reachable && ai.modelAvailable ? 'ok' : 'warn'} title={ai.baseUrl}>
          AI {ai.model} · {!ai.reachable ? 'unreachable' : ai.modelAvailable ? 'ready' : 'model missing'}
        </Chip>
      )}
      {github.mode === 'mock' && <Chip tone="warn">Mock repo</Chip>}
      {github.mode !== 'mock' &&
        repos.map((r) => (
          <Chip key={r.id} tone="ok" title={`${r.webUrl ?? r.name}@${r.baseBranch}`}>
            {r.provider === 'gitlab' ? 'GitLab' : 'GitHub'} {r.name}
          </Chip>
        ))}
      {github.mode !== 'mock' && repos.length === 0 && (
        <Chip tone="off" title={`Missing: ${github.missing.join(', ')}`}>
          No repository
        </Chip>
      )}
      <Chip tone={teams.configured ? 'ok' : 'off'}>Teams {teams.configured ? 'on' : 'off'}</Chip>
    </div>
  );
}

export default function App() {
  const [hash, navigate] = useHash();
  const detail = hash.match(/^#\/incidents\/([\w-]+)/);

  return (
    <div className="relative min-h-screen overflow-x-hidden">
      {/* ambient glow */}
      <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-0">
        <div className="absolute -left-40 -top-40 h-[480px] w-[480px] rounded-full bg-violet-600/20 blur-[120px]" />
        <div className="absolute -right-40 top-20 h-[420px] w-[420px] rounded-full bg-cyan-500/10 blur-[120px]" />
        <div className="absolute inset-0 bg-[radial-gradient(rgba(255,255,255,0.035)_1px,transparent_1px)] [background-size:24px_24px]" />
      </div>

      <header className="sticky top-0 z-40 border-b border-edge bg-base/70 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <a href="#/" className="flex items-center gap-3">
            <Logo />
            <span className="leading-tight">
              <span className="block font-display text-lg font-bold tracking-tight brand-text">Nagent</span>
              <span className="block text-[11px] text-fg-muted">AI incident agent</span>
            </span>
          </a>
          <SystemStatus />
        </div>
      </header>

      <main className="relative z-10 mx-auto max-w-6xl px-4 py-8 sm:px-6">
        {detail ? <IncidentDetail key={detail[1]} id={detail[1]} /> : <IncidentList navigate={navigate} />}
      </main>

      <footer className="relative z-10 mx-auto max-w-6xl px-4 pb-8 text-center text-xs text-fg-muted sm:px-6">
        Nagent · local AI root-cause analysis · every PR needs human approval
      </footer>
    </div>
  );
}
