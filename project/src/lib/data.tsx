import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, type AuditEvent, type IncidentSummary } from './api';

export interface Decision extends AuditEvent {
  approved: boolean;
}

/**
 * Approve/reject decisions from the audit trail. PRs opened before approvals were recorded as their own
 * event only have the "Creating branch …" event; those count as approvals (actor unknown).
 */
export function approvalDecisions(audit: AuditEvent[] | null): Decision[] {
  const events = audit ?? [];
  const recorded = new Set(events.filter((e) => e.type === 'approval').map((e) => e.incidentId));
  const legacy = new Set<string>(); // one legacy approval per incident (PR retries repeat "Creating branch")
  return events
    .filter((e) => {
      if (e.type === 'approval') return /^(Patch approved|Auto-approved|Patch rejected)/.test(e.message);
      if (e.type !== 'pr' || !/^Creating branch/.test(e.message) || recorded.has(e.incidentId) || legacy.has(e.incidentId)) return false;
      legacy.add(e.incidentId);
      return true;
    })
    .map((e) => ({ ...e, approved: !/^Patch rejected/.test(e.message) }));
}

/**
 * Shared, polled data for every page: the incident list (5 s), the audit log (15 s), the environment
 * chosen in the top bar and the operator's name. Pages filter this instead of fetching their own copy.
 */
interface DataState {
  incidents: IncidentSummary[] | null;
  /** Incidents in the environment chosen in the top bar. */
  scoped: IncidentSummary[] | null;
  error: string | null;
  updatedAt: number | null;
  refresh: () => Promise<void>;
  audit: AuditEvent[] | null;
  refreshAudit: () => Promise<void>;
  environment: string;
  setEnvironment: (env: string) => void;
  environments: string[];
  operator: string;
  setOperator: (name: string) => void;
}

const DataContext = createContext<DataState | null>(null);

export const ALL_ENVIRONMENTS = 'all';

function stored(key: string, fallback: string): string {
  try {
    return localStorage.getItem(`nagent.${key}`) ?? fallback;
  } catch {
    return fallback;
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(`nagent.${key}`, value);
  } catch {
    // per-browser convenience only
  }
}

export function DataProvider({ children }: { children: ReactNode }) {
  const [incidents, setIncidents] = useState<IncidentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [audit, setAudit] = useState<AuditEvent[] | null>(null);
  const [environment, setEnv] = useState(() => stored('environment', ALL_ENVIRONMENTS));
  const [operator, setOp] = useState(() => stored('operator', ''));

  const refresh = useCallback(async () => {
    try {
      setIncidents(await api.list());
      setError(null);
      setUpdatedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const refreshAudit = useCallback(async () => {
    try {
      setAudit(await api.audit(500));
    } catch {
      // the audit log is secondary; pages show their own empty state
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    void refreshAudit();
    const t = setInterval(refreshAudit, 15000);
    return () => clearInterval(t);
  }, [refreshAudit]);

  const environments = useMemo(
    () => [...new Set((incidents ?? []).map((i) => i.environment).filter((e): e is string => Boolean(e)))].sort(),
    [incidents],
  );
  const scoped = useMemo(
    () => (incidents && environment !== ALL_ENVIRONMENTS ? incidents.filter((i) => i.environment === environment) : incidents),
    [incidents, environment],
  );

  const value: DataState = {
    incidents,
    scoped,
    error,
    updatedAt,
    refresh,
    audit,
    refreshAudit,
    environment,
    setEnvironment: (env) => {
      setEnv(env);
      store('environment', env);
    },
    environments,
    operator,
    setOperator: (name) => {
      const n = name.trim().slice(0, 60);
      setOp(n);
      store('operator', n);
    },
  };
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useData(): DataState {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error('useData outside DataProvider');
  return ctx;
}

// ---------- shared definitions ----------

export const isOpen = (i: { status: string }) => i.status !== 'resolved';
export const isActive = (i: IncidentSummary) => i.running || ['open', 'investigating', 'creating_pr'].includes(i.status);
/** An investigation the Stop action can cancel (PR creation cannot be stopped). */
export const stoppable = (i: { running: boolean; status: string }) => i.running && i.status !== 'creating_pr';
export const approvable = (i: { status: string; remediationStatus?: string; running: boolean }) =>
  !i.running && (i.remediationStatus === 'awaiting_approval' || i.remediationStatus === 'pr_failed');

export const DAY = 86_400_000;

/** Mean time from report to fix (PR opened or resolved, whichever came first) for incidents fixed in [from, to). */
export function meanTimeToFix(incidents: IncidentSummary[], from: number, to: number): number | null {
  const times = incidents
    .map((i) => {
      const done = [i.fixedAt, i.resolvedAt].filter((t): t is string => Boolean(t)).map((t) => Date.parse(t));
      return done.length ? { start: Date.parse(i.createdAt), end: Math.min(...done) } : null;
    })
    .filter((t): t is { start: number; end: number } => t !== null && t.end >= from && t.end < to)
    .map((t) => t.end - t.start);
  return times.length ? times.reduce((a, b) => a + b, 0) / times.length : null;
}

/** Initials for an avatar: "Navendu Dixit" → "ND". */
export function initials(name: string): string {
  const parts = name.trim().split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : (parts[0]?.[1] ?? ''))).toUpperCase() || '?';
}

/** Short repository label: "Navendu-creator/Sonar" → "Sonar". */
export const shortRepo = (name: string) => name.split('/').pop() || name;
