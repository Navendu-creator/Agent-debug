import type { ReactNode } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import type { IncidentStatus, Severity } from '@/lib/api';

const SEVERITY: Record<Severity, string> = {
  critical: 'bg-rose-500/15 text-rose-300 ring-rose-500/40',
  high: 'bg-orange-500/15 text-orange-300 ring-orange-500/40',
  medium: 'bg-amber-500/10 text-amber-200 ring-amber-500/30',
  low: 'bg-slate-500/15 text-slate-300 ring-slate-500/30',
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider ring-1 ${SEVERITY[severity]}`}>
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
};

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
