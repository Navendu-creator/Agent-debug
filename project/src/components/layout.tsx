import { useState, type ReactNode } from 'react';
import {
  Activity, Bell, Box, ChevronDown, ClipboardCheck, Cpu, Database, ExternalLink, FolderGit2, Globe, House, Keyboard, Layers,
  Menu as MenuIcon, Network, Plus, RefreshCw, ScrollText, Server, Settings, ShieldCheck, Ship, TriangleAlert, UserRound, Webhook, X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { ALL_ENVIRONMENTS, approvable, isOpen, useData } from '@/lib/data';
import { timeAgo } from '@/lib/format';
import { aiReady, repositories, useHealth } from '@/lib/health';
import { usePrompt } from './feedback';
import { MenuHeading, Popover, Select } from './menu';
import { Avatar, Dot, Logo, RepoIcon } from './ui';

export type Page = 'overview' | 'incidents' | 'services' | 'repositories' | 'approvals' | 'audit' | 'settings';

// ---------- sidebar ----------

function NavItem({ href, icon: Icon, label, active, badge, onNavigate }: { href: string; icon: LucideIcon; label: string; active: boolean; badge?: number; onNavigate?: () => void }) {
  return (
    <a
      href={href}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={`group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition ${
        active ? 'bg-gradient-to-r from-violet-500/25 to-violet-500/5 font-medium text-fg ring-1 ring-violet-500/40' : 'text-fg-soft hover:bg-panel-2 hover:text-fg'
      }`}
    >
      <Icon className={`h-[18px] w-[18px] ${active ? 'text-violet-200' : 'text-fg-muted group-hover:text-fg-soft'}`} />
      <span className="flex-1">{label}</span>
      {badge ? <span className="min-w-[22px] rounded-full bg-rose-500/90 px-1.5 text-center text-[11px] font-semibold leading-5 text-white">{badge > 99 ? '99+' : badge}</span> : null}
    </a>
  );
}

export function Sidebar({ page, open, onClose }: { page: Page; open: boolean; onClose: () => void }) {
  const { scoped } = useData();
  const { health } = useHealth();
  const openCount = scoped?.filter(isOpen).length ?? 0;
  const pending = scoped?.filter(approvable).length ?? 0;
  const auto = health?.github.autoCreatePr;
  const items: Array<{ page: Page; href: string; icon: LucideIcon; label: string; badge?: number }> = [
    { page: 'overview', href: '#/', icon: House, label: 'Overview' },
    { page: 'incidents', href: '#/incidents', icon: TriangleAlert, label: 'Incidents', badge: openCount },
    { page: 'services', href: '#/services', icon: Layers, label: 'Services' },
    { page: 'repositories', href: '#/repositories', icon: FolderGit2, label: 'Repositories' },
    { page: 'approvals', href: '#/approvals', icon: ClipboardCheck, label: 'Approvals', badge: pending },
    { page: 'audit', href: '#/audit', icon: ScrollText, label: 'Audit log' },
    { page: 'settings', href: '#/settings', icon: Settings, label: 'Settings' },
  ];
  return (
    <>
      {open && <div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden" onClick={onClose} aria-hidden="true" />}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-60 flex-col border-r border-edge bg-[#080d18] transition-transform lg:translate-x-0 ${open ? 'translate-x-0' : '-translate-x-full'}`}
      >
        <div className="flex h-16 items-center justify-between px-5">
          <a href="#/" className="flex items-center gap-2.5" onClick={onClose}>
            <Logo size={30} />
            <span className="font-display text-lg font-bold tracking-tight text-fg">Nagent</span>
            <span className="text-xs font-medium text-fg-muted">AI SRE</span>
          </a>
          <button onClick={onClose} className="btn-icon lg:hidden" aria-label="Close menu">
            <X className="h-4 w-4" />
          </button>
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-3" aria-label="Main">
          {items.map((it) => (
            <NavItem key={it.page} {...it} active={page === it.page} onNavigate={onClose} />
          ))}
        </nav>
        <div className="m-3 rounded-xl border border-edge bg-panel/80 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-fg">
            <ShieldCheck className={`h-5 w-5 ${auto ? 'text-amber-300' : 'text-emerald-400'}`} />
            {auto ? 'Auto-approve is on' : 'Safe & auditable'}
          </div>
          <p className="text-xs leading-relaxed text-fg-muted">
            {auto
              ? 'AUTO_CREATE_PR=true — validated patches open PRs without a human approval.'
              : 'Every code change needs human approval. Each action is recorded in the audit trail.'}
          </p>
          <a href="#/audit" onClick={onClose} className="mt-2 inline-block text-xs text-violet-300 hover:underline">
            View audit log →
          </a>
        </div>
      </aside>
    </>
  );
}

// ---------- top bar ----------

function EnvironmentSelect() {
  const { environment, setEnvironment, environments } = useData();
  const options = [
    { value: ALL_ENVIRONMENTS, label: 'All environments', icon: <Globe className="h-4 w-4 text-fg-muted" /> },
    ...environments.map((e) => ({ value: e, label: e[0].toUpperCase() + e.slice(1), icon: <Dot tone={/prod/i.test(e) ? 'ok' : 'warn'} /> })),
  ];
  // Keep a remembered environment visible even if no incident uses it any more.
  if (!options.some((o) => o.value === environment)) options.push({ value: environment, label: environment, icon: <Dot tone="off" /> });
  return <Select ariaLabel="Environment" value={environment} onChange={setEnvironment} options={options} className="max-w-[150px] sm:min-w-[150px] sm:max-w-none" panelClassName="w-56" />;
}

type Tone = 'ok' | 'warn' | 'off' | 'error';

function StatusRow({ icon, title, detail, tone, state, href }: { icon: ReactNode; title: ReactNode; detail?: ReactNode; tone: Tone; state: string; href?: string | null }) {
  const body = (
    <>
      <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-panel ring-1 ring-edge">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 truncate text-sm text-fg">
          {title}
          {href && <ExternalLink className="h-3 w-3 flex-shrink-0 text-fg-muted opacity-0 transition group-hover:opacity-100" />}
        </span>
        {detail && <span className="block truncate font-mono text-[11px] text-fg-muted">{detail}</span>}
      </span>
      <span className="flex flex-shrink-0 items-center gap-1.5 text-[11px] text-fg-soft">
        <Dot tone={tone} />
        {state}
      </span>
    </>
  );
  const cls = 'group flex items-center gap-3 rounded-lg px-2.5 py-2';
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className={`${cls} transition hover:bg-panel-3`}>
      {body}
    </a>
  ) : (
    <div className={cls}>{body}</div>
  );
}

const chip = 'btn-secondary h-9 gap-2 rounded-xl px-3 text-xs';

function AgentHealth() {
  const { health, down, checkedAt, refresh } = useHealth();
  if (down) {
    return (
      <button onClick={refresh} className={`${chip} border-rose-500/40 text-rose-200`} title="Retry">
        <Dot tone="error" /> Backend unreachable
      </button>
    );
  }
  if (!health) return <div className="h-9 w-36 animate-pulse rounded-xl bg-panel-2" />;
  const { ai, teams, webhooks, database } = health;
  const ready = aiReady(health);
  const tone: Tone = !database.ok || (!ai.demoMode && !ai.reachable) ? 'error' : ready ? 'ok' : 'warn';
  const label = tone === 'ok' ? 'Agent healthy' : tone === 'warn' ? 'Agent degraded' : 'Agent down';
  return (
    <Popover
      role="dialog"
      ariaLabel="Agent health"
      panelClassName="w-[min(24rem,calc(100vw-2rem))] p-1.5"
      buttonClassName={`${chip} ${tone === 'ok' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-100' : tone === 'warn' ? 'border-amber-500/30 bg-amber-500/10 text-amber-100' : 'border-rose-500/40 bg-rose-500/10 text-rose-100'}`}
      button={
        <>
          <Dot tone={tone} /> <span className="hidden sm:inline">{label}</span>
        </>
      }
    >
      <div className="flex items-center justify-between px-2.5 pb-1 pt-2">
        <span className="text-sm font-semibold text-fg">{label}</span>
        <button onClick={refresh} data-autofocus className="btn-icon h-7 w-7" aria-label="Refresh status" title="Refresh">
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>
      <MenuHeading>Components</MenuHeading>
      <StatusRow
        icon={<Cpu className="h-4 w-4 text-violet-300" />}
        title="AI engine"
        detail={ai.demoMode ? 'Demo heuristic — no model' : `Ollama · ${ai.model}`}
        tone={ready ? 'ok' : ai.demoMode || ai.reachable ? 'warn' : 'error'}
        state={ai.demoMode ? 'Demo' : !ai.reachable ? 'Unreachable' : ai.modelAvailable ? 'Ready' : 'Downloading'}
      />
      <StatusRow icon={<Database className="h-4 w-4 text-emerald-300" />} title="Database" detail="SQLite" tone={database.ok ? 'ok' : 'error'} state={database.ok ? 'Healthy' : 'Error'} />
      <StatusRow icon={<Bell className="h-4 w-4 text-sky-300" />} title="Microsoft Teams" tone={teams.configured ? 'ok' : 'off'} state={teams.configured ? 'On' : 'Off'} />
      <StatusRow
        icon={<Webhook className="h-4 w-4 text-cyan-300" />}
        title="Alert webhook"
        detail="/api/webhooks/alerts"
        tone={webhooks.secretConfigured ? 'ok' : 'warn'}
        state={webhooks.secretConfigured ? 'Secured' : 'No secret'}
      />
      {checkedAt && <p className="mt-1 border-t border-edge px-2.5 pb-1 pt-2 text-[11px] text-fg-muted">Checked {timeAgo(new Date(checkedAt).toISOString())}</p>}
    </Popover>
  );
}

function ModelMenu() {
  const { health } = useHealth();
  if (!health) return null;
  const { ai } = health;
  const ready = aiReady(health);
  return (
    <Popover
      role="dialog"
      ariaLabel="AI model"
      panelClassName="w-72 p-3"
      buttonClassName={`${chip} hidden md:inline-flex`}
      button={
        <>
          <Cpu className="h-4 w-4 text-violet-300" />
          <span className="font-mono">{ai.demoMode ? 'demo' : ai.model}</span>
          <ChevronDown className="h-3.5 w-3.5 text-fg-muted" />
        </>
      }
    >
      <div className="mb-3 flex items-center justify-between">
        <span className="font-mono text-sm text-fg">{ai.demoMode ? 'Demo heuristic' : ai.model}</span>
        <span className="flex items-center gap-1.5 text-xs text-fg-soft">
          <Dot tone={ready ? 'ok' : ai.reachable ? 'warn' : 'error'} />
          {ai.demoMode ? 'Demo mode' : !ai.reachable ? 'Unreachable' : ai.modelAvailable ? 'Ready' : 'Downloading'}
        </span>
      </div>
      <dl className="space-y-1.5 text-xs">
        {[
          ['Provider', 'Ollama (local)'],
          ['Endpoint', ai.baseUrl],
          ['CPU threads', ai.numThread ? String(ai.numThread) : 'Ollama default'],
          ['Timeout', ai.timeoutMinutes ? `${ai.timeoutMinutes} min` : '—'],
        ].map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3">
            <dt className="text-fg-muted">{k}</dt>
            <dd className="truncate font-mono text-fg-soft">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 border-t border-edge pt-2 text-[11px] text-fg-muted">Change with OLLAMA_MODEL in backend/.env.</p>
    </Popover>
  );
}

function ReposMenu() {
  const { health } = useHealth();
  const repos = repositories(health);
  if (!health) return null;
  const providers = [...new Set(repos.map((r) => r.provider))];
  return (
    <Popover
      role="dialog"
      ariaLabel="Repositories"
      panelClassName="w-[min(26rem,calc(100vw-2rem))] p-1.5"
      buttonClassName={`${chip} hidden lg:inline-flex`}
      button={
        <>
          {providers.length ? providers.map((p) => <RepoIcon key={p} provider={p} className="h-4 w-4" />) : <FolderGit2 className="h-4 w-4 text-fg-muted" />}
          {health.github.mode === 'mock' ? 'Mock repository' : repos.length ? `${repos.length} connected` : 'No repository'}
          <ChevronDown className="h-3.5 w-3.5 text-fg-muted" />
        </>
      }
    >
      <MenuHeading>Repositories · {repos.length}</MenuHeading>
      {repos.length === 0 && <p className="px-2.5 py-2 text-sm text-fg-muted">Set GITHUB_* or GITLAB_* in backend/.env.</p>}
      {repos.map((r) => (
        <StatusRow
          key={r.id}
          href={r.webUrl}
          icon={<RepoIcon provider={r.provider} />}
          title={
            <>
              <span className="truncate" title={r.name}>{r.name}</span>
              {r.isDefault && repos.length > 1 && <span className="rounded bg-violet-500/20 px-1.5 text-[10px] font-medium text-violet-200">default</span>}
            </>
          }
          detail={`${r.provider === 'gitlab' ? 'GitLab' : 'GitHub'} · ${r.baseBranch ?? 'main'}`}
          tone="ok"
          state="Connected"
        />
      ))}
      <a href="#/repositories" className="mt-1 block border-t border-edge px-2.5 pb-1 pt-2 text-xs text-violet-300 hover:underline">
        Manage repositories →
      </a>
    </Popover>
  );
}

const NOTIFY = (e: { type: string; message: string }) =>
  e.type === 'pr' ? /created/.test(e.message) : e.type === 'error' || e.type === 'approval' || (e.type === 'analysis' && /^RCA generated/.test(e.message)) || (e.type === 'intake' && /received/.test(e.message));

function readSeen(): number {
  try {
    return Number(localStorage.getItem('nagent.notificationsSeen')) || 0;
  } catch {
    return 0;
  }
}

function Notifications() {
  const { audit } = useData();
  const [seen, setSeen] = useState(readSeen);
  const [highlightAfter, setHighlightAfter] = useState(seen);
  const items = (audit ?? []).filter((e) => e.exists && NOTIFY(e)).slice(0, 25);
  const unread = items.filter((e) => Date.parse(e.at) > seen).length;
  const markRead = () => {
    const now = Date.now();
    setSeen(now);
    try {
      localStorage.setItem('nagent.notificationsSeen', String(now));
    } catch {
      // per-browser only
    }
  };
  return (
    <Popover
      role="dialog"
      ariaLabel={`Notifications${unread ? ` (${unread} unread)` : ''}`}
      panelClassName="w-[min(24rem,calc(100vw-2rem))] p-1.5"
      buttonClassName="btn-icon relative h-9 w-9"
      onOpenChange={(open) => {
        if (open) setHighlightAfter(seen);
        else if (unread) markRead();
      }}
      button={
        <>
          <Bell className="h-[18px] w-[18px]" />
          {unread > 0 && (
            <span className="absolute -right-0.5 -top-0.5 min-w-[18px] rounded-full bg-rose-500 px-1 text-center text-[10px] font-semibold leading-[18px] text-white">
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </>
      }
    >
      <div className="flex items-center justify-between px-2.5 pb-1 pt-2">
        <span className="text-sm font-semibold text-fg">Notifications</span>
        {unread > 0 && (
          <button onClick={markRead} data-autofocus className="text-xs text-violet-300 hover:underline">
            Mark all read
          </button>
        )}
      </div>
      <div className="scrollbar-thin max-h-[60vh] overflow-y-auto">
        {items.length === 0 && <p className="px-2.5 py-6 text-center text-sm text-fg-muted">No notifications yet.</p>}
        {items.map((e, i) => {
          const fresh = Date.parse(e.at) > highlightAfter;
          const tone = e.type === 'error' ? 'bg-rose-400' : e.type === 'pr' ? 'bg-emerald-400' : e.type === 'approval' ? 'bg-amber-400' : e.type === 'analysis' ? 'bg-violet-400' : 'bg-sky-400';
          return (
            <a key={i} href={`#/incidents/${e.incidentId}`} className={`flex gap-3 rounded-lg px-2.5 py-2 transition hover:bg-panel-3 ${fresh ? 'bg-violet-500/[0.06]' : ''}`}>
              <span className={`mt-1.5 h-2 w-2 flex-shrink-0 rounded-full ${tone}`} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium text-fg">{e.incidentTitle}</span>
                <span className="line-clamp-2 block text-xs text-fg-soft">{e.message}</span>
                <span className="font-mono text-[10px] text-fg-muted">
                  {e.incidentId} · {timeAgo(e.at)}
                </span>
              </span>
            </a>
          );
        })}
      </div>
    </Popover>
  );
}

function UserMenu() {
  const { operator, setOperator } = useData();
  const prompt = usePrompt();
  const setName = async () => {
    const name = await prompt({
      title: 'Your name',
      body: <p>Shown in the audit log for approvals, rejections and other actions you take. Stored in this browser only — there is no login.</p>,
      label: 'Name',
      placeholder: 'e.g. Navendu Dixit',
      initial: operator,
      required: true,
    });
    if (name) setOperator(name);
  };
  return (
    <Popover
      ariaLabel="Account"
      panelClassName="w-64"
      buttonClassName="flex h-9 items-center gap-2 rounded-xl px-1.5 text-sm text-fg-soft transition hover:bg-panel-2"
      button={
        <>
          {operator ? <Avatar name={operator} size="h-8 w-8 text-xs" /> : <span className="flex h-8 w-8 items-center justify-center rounded-full bg-panel-3 ring-1 ring-edge"><UserRound className="h-4 w-4" /></span>}
          <span className="hidden max-w-[140px] truncate xl:inline">{operator || 'Set your name'}</span>
          <ChevronDown className="hidden h-3.5 w-3.5 text-fg-muted xl:inline" />
        </>
      }
    >
      {(close) => (
        <>
          <div className="px-2.5 py-2">
            <p className="truncate text-sm font-medium text-fg">{operator || 'Anonymous operator'}</p>
            <p className="text-[11px] text-fg-muted">Name used in the audit log</p>
          </div>
          <div className="my-1 h-px bg-edge" />
          <button role="menuitem" className="menu-item" onClick={() => (close(), void setName())}>
            <UserRound className="mt-0.5 h-4 w-4 text-fg-muted" /> {operator ? 'Change name' : 'Set your name'}
          </button>
          <a role="menuitem" href="#/incidents?owner=me" onClick={close} className="menu-item">
            <ClipboardCheck className="mt-0.5 h-4 w-4 text-fg-muted" /> My incidents
          </a>
          <a role="menuitem" href="#/settings" onClick={close} className="menu-item">
            <Settings className="mt-0.5 h-4 w-4 text-fg-muted" /> Settings
          </a>
          <div className="my-1 h-px bg-edge" />
          <div className="px-2.5 py-1.5 text-[11px] text-fg-muted">
            <Keyboard className="mr-1 inline h-3 w-3" /> <kbd className="kbd">N</kbd> new incident · <kbd className="kbd">/</kbd> search
          </div>
        </>
      )}
    </Popover>
  );
}

export function Topbar({ onMenu, onReport }: { onMenu: () => void; onReport: () => void }) {
  return (
    <header className="sticky top-0 z-30 border-b border-edge bg-base/85 backdrop-blur-xl">
      <div className="flex h-16 items-center gap-1.5 px-3 sm:gap-2 sm:px-6">
        <button onClick={onMenu} className="btn-icon lg:hidden" aria-label="Open menu">
          <MenuIcon className="h-5 w-5" />
        </button>
        <EnvironmentSelect />
        <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
          <AgentHealth />
          <ModelMenu />
          <ReposMenu />
          <Notifications />
          <button onClick={onReport} className="btn-primary h-9 px-3 text-xs" title="New incident (N)">
            <Plus className="h-4 w-4" /> <span className="hidden sm:inline">New incident</span>
          </button>
          <span className="mx-1 hidden h-6 w-px bg-edge sm:block" />
          <UserMenu />
        </div>
      </div>
    </header>
  );
}

// ---------- service icon ----------

const SERVICE_ICONS: Array<[RegExp, LucideIcon, string]> = [
  [/terraform|\btf\b|infra|iac/i, Layers, 'text-violet-300'],
  [/k8s|kube|eks|aks|gke|cluster|helm|argo|pod/i, Ship, 'text-sky-300'],
  [/db|postgres|sql|mysql|redis|mongo/i, Database, 'text-emerald-300'],
  [/dns|network|vpc|ingress|gateway|lb\b/i, Network, 'text-cyan-300'],
  [/api|payment|checkout|order|web|app|front|service/i, Server, 'text-amber-200'],
  [/sonar|scan|monitor|observ|metric/i, Activity, 'text-teal-300'],
];

export function ServiceIcon({ name, className = 'h-4 w-4' }: { name?: string; className?: string }) {
  const hit = name ? SERVICE_ICONS.find(([re]) => re.test(name)) : undefined;
  const [, Icon, tint] = hit ?? [null, Box, 'text-fg-muted'];
  return <Icon className={`${className} flex-shrink-0 ${tint}`} />;
}
