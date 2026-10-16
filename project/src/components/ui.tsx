import type { ReactNode } from 'react';
import { AlertTriangle, Github, Gitlab, Loader2 } from 'lucide-react';
import type { IncidentStatus, Severity } from '@/lib/api';
import { initials } from '@/lib/data';

const SEVERITY: Record<Severity, string> = {
  critical: 'bg-rose-500/15 text-rose-300 ring-rose-500/40',
  high: 'bg-orange-500/15 text-orange-300 ring-orange-500/40',
  medium: 'bg-amber-500/10 text-amber-200 ring-amber-500/30',
  low: 'bg-teal-500/10 text-teal-200 ring-teal-500/30',
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <span className={`inline-flex min-w-[74px] items-center justify-center rounded-md px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider ring-1 ${SEVERITY[severity]}`}>
      {severity}
    </span>
  );
}

const STATUS: Record<IncidentStatus, { label: string; cls: string; dot: string; live?: boolean }> = {
  open: { label: 'Open', cls: 'bg-slate-500/15 text-slate-300 ring-slate-500/30', dot: 'bg-slate-400' },
  investigating: { label: 'Investigating', cls: 'bg-sky-500/15 text-sky-300 ring-sky-500/40', dot: 'bg-sky-400', live: true },
  rca_ready: { label: 'RCA ready', cls: 'bg-violet-500/15 text-violet-300 ring-violet-500/40', dot: 'bg-violet-400' },
  awaiting_approval: { label: 'Awaiting approval', cls: 'bg-amber-500/15 text-amber-200 ring-amber-500/40', dot: 'bg-amber-400', live: true },
  creating_pr: { label: 'Creating PR', cls: 'bg-sky-500/15 text-sky-300 ring-sky-500/40', dot: 'bg-sky-400', live: true },
  pr_created: { label: 'PR created', cls: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/40', dot: 'bg-emerald-400' },
  failed: { label: 'Failed', cls: 'bg-rose-500/15 text-rose-300 ring-rose-500/40', dot: 'bg-rose-400' },
  cancelled: { label: 'Stopped', cls: 'bg-slate-500/15 text-slate-300 ring-slate-400/40', dot: 'bg-slate-300' },
  rejected: { label: 'Patch rejected', cls: 'bg-fuchsia-500/10 text-fuchsia-200 ring-fuchsia-500/30', dot: 'bg-fuchsia-300' },
  resolved: { label: 'Resolved', cls: 'bg-teal-500/15 text-teal-200 ring-teal-500/40', dot: 'bg-teal-300' },
};

/** Severity colors for marks (chart segments, dots, row accents) — validated as a set on the dark surface. */
export const SEVERITY_COLOR: Record<Severity, string> = {
  critical: '#e8435f',
  high: '#c08712',
  medium: '#7a6cf0',
  low: '#1c9c96',
};
export const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low'];
export const SEVERITY_LABEL: Record<Severity, string> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };

export function PageHeader({ title, subtitle, right }: { title: string; subtitle?: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="font-display text-2xl font-bold tracking-tight text-fg">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-fg-muted">{subtitle}</p>}
      </div>
      {right && <div className="flex flex-wrap items-center gap-2">{right}</div>}
    </div>
  );
}

/** KPI tile: label, value, optional delta line, tinted icon. Clickable when `onClick` is given. */
export function StatCard({
  label,
  value,
  icon,
  tint,
  foot,
  active,
  onClick,
}: {
  label: string;
  value: ReactNode;
  icon: ReactNode;
  tint: string;
  foot?: ReactNode;
  active?: boolean;
  onClick?: () => void;
}) {
  const body = (
    <>
      <span className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full sm:h-10 sm:w-10 ${tint}`}>{icon}</span>
      <span className="min-w-0">
        <span className="line-clamp-2 block text-[13px] leading-snug text-fg-soft">{label}</span>
        <span className="block font-display text-[26px] font-bold leading-tight tabular-nums text-fg">{value}</span>
        {foot && <span className="block truncate text-[11px] text-fg-muted">{foot}</span>}
      </span>
    </>
  );
  const cls = `flex min-w-0 items-start gap-3 rounded-xl border p-4 text-left shadow-panel transition ${
    active ? 'border-violet-500/60 bg-violet-500/10' : 'border-edge bg-panel/80'
  }`;
  return onClick ? (
    <button onClick={onClick} aria-pressed={active} className={`${cls} hover:border-edge-strong hover:bg-panel-2`}>
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  );
}

/** Up/down change vs a previous period; `goodWhenUp` decides the color. */
export function Delta({ value, goodWhenUp = false, suffix = '', label }: { value: number; goodWhenUp?: boolean; suffix?: string; label: string }) {
  const good = value === 0 ? null : (value > 0) === goodWhenUp;
  const arrow = value > 0 ? '↑' : value < 0 ? '↓' : '→';
  return (
    <span>
      <span className={good === null ? 'text-fg-soft' : good ? 'text-emerald-400' : 'text-rose-400'}>
        {arrow} {Math.abs(value)}
        {suffix}
      </span>{' '}
      {label}
    </span>
  );
}

export function Avatar({ name, size = 'h-7 w-7 text-[10px]' }: { name: string; size?: string }) {
  const text = initials(name);
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const hues = ['bg-violet-500/25 text-violet-100', 'bg-sky-500/25 text-sky-100', 'bg-teal-500/25 text-teal-100', 'bg-amber-500/25 text-amber-100', 'bg-fuchsia-500/25 text-fuchsia-100'];
  return (
    <span title={name} className={`inline-flex flex-shrink-0 items-center justify-center rounded-full font-semibold ring-1 ring-white/10 ${hues[hash % hues.length]} ${size}`}>
      {text}
    </span>
  );
}

export function RepoIcon({ provider, className = 'h-4 w-4' }: { provider: string; className?: string }) {
  return provider === 'gitlab' ? <Gitlab className={`${className} text-orange-400`} /> : <Github className={`${className} text-fg`} />;
}

/** Small status light: green, amber or grey. */
export function Dot({ tone }: { tone: 'ok' | 'warn' | 'off' | 'error' }) {
  const cls = { ok: 'bg-emerald-400', warn: 'bg-amber-400', off: 'bg-fg-muted/60', error: 'bg-rose-400' }[tone];
  return (
    <span className="relative flex h-2 w-2 flex-shrink-0">
      {tone === 'ok' && <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-40 ${cls}`} />}
      <span className={`relative inline-flex h-2 w-2 rounded-full ${cls}`} />
    </span>
  );
}

export function StatusBadge({ status }: { status: IncidentStatus }) {
  const s = STATUS[status] ?? STATUS.open;
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ${s.cls}`}>
      <span className="relative flex h-1.5 w-1.5">
        {s.live && <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-70 ${s.dot}`} />}
        <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${s.dot}`} />
      </span>
      {s.label}
    </span>
  );
}

export function Card({
  title,
  icon,
  children,
  right,
  className = '',
}: {
  title: string;
  icon?: ReactNode;
  children: ReactNode;
  right?: ReactNode;
  className?: string;
}) {
  return (
    <section className={`animate-fade-up rounded-2xl border border-edge bg-panel/80 shadow-panel backdrop-blur ${className}`}>
      <header className="flex items-center justify-between gap-3 border-b border-edge px-5 py-3.5">
        <h2 className="flex items-center gap-2.5 font-display font-semibold text-fg">
          {icon && (
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500/25 to-cyan-500/20 text-violet-200 ring-1 ring-violet-500/30">
              {icon}
            </span>
          )}
          {title}
        </h2>
        {right}
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex items-start gap-3 rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-200">
      <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-rose-400" />
      <div className="flex-1 break-words">{message}</div>
      {onRetry && (
        <button onClick={onRetry} className="font-medium text-rose-100 underline underline-offset-2 hover:no-underline">
          Retry
        </button>
      )}
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-sm text-fg-muted">
      <Loader2 className="h-4 w-4 animate-spin text-violet-400" /> {label}
    </div>
  );
}

export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="nagent-logo" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8b5cf6" />
          <stop offset="1" stopColor="#22d3ee" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#nagent-logo)" />
      <path d="M10 22V10l12 12V10" fill="none" stroke="white" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="22" cy="10" r="2.2" fill="white" />
    </svg>
  );
}

/** Plain titled section used by dashboard pages. */
export function Panel({ title, right, children, className = '', bodyClassName = 'p-5' }: { title: ReactNode; right?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string }) {
  return (
    <section className={`min-w-0 rounded-xl border border-edge bg-panel/80 shadow-panel ${className}`}>
      <header className="flex items-center justify-between gap-3 px-5 pt-4">
        <h2 className="font-display text-[15px] font-semibold text-fg">{title}</h2>
        {right}
      </header>
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

export function ConfidenceBar({ value }: { value?: number }) {
  if (value === undefined) return <span className="text-xs text-fg-muted">—</span>;
  return (
    <div className="w-20">
      <div className="mb-1 text-xs tabular-nums text-fg-soft">{value}%</div>
      <div className="h-1.5 overflow-hidden rounded-full bg-panel-3">
        <div className="h-full rounded-full bg-gradient-to-r from-violet-500 to-cyan-400" style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}
