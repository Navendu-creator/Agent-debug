// Types mirror backend/src/types.ts (API shapes only).

export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type IncidentStatus =
  | 'open'
  | 'investigating'
  | 'rca_ready'
  | 'awaiting_approval'
  | 'creating_pr'
  | 'pr_created'
  | 'failed'
  | 'cancelled'
  | 'rejected'
  | 'resolved';
export type RemediationStatus =
  | 'not_configured'
  | 'blocked'
  | 'validation_failed'
  | 'awaiting_approval'
  | 'creating_pr'
  | 'pr_created'
  | 'pr_failed'
  | 'rejected';

export interface TimelineEvent {
  at: string;
  type: string;
  message: string;
  actor?: string;
}

export interface AuditEvent extends TimelineEvent {
  incidentId: string;
  incidentTitle: string;
  /** False when the incident has since been deleted. */
  exists: boolean;
}

export interface Evidence {
  type: 'fact' | 'hypothesis';
  statement: string;
  quote?: string;
  source?: 'report' | 'repository';
}

export interface Analysis {
  summary: string;
  probableRootCause: string;
  evidence: Evidence[];
  confidence: number;
  recommendedFix: string;
  preventiveActions: string[];
  proposedChanges: Array<{ file: string; description: string }>;
  validationPlan: string[];
  limitations: string[];
}

/** Repository id: "github", "gitlab", "github-2"… (see backend/.env). */
export type RepoTarget = string;

export interface Remediation {
  status: RemediationStatus;
  provider: 'github' | 'gitlab' | 'mock' | 'none';
  repo?: string;
  repoUrl?: string;
  baseBranch?: string;
  changes: Array<{ path: string; description: string; diff: string }>;
  rejected: Array<{ file: string; reason: string }>;
  checks: Array<{ name: string; file?: string; status: 'passed' | 'failed' | 'skipped'; detail: string }>;
  message?: string;
  branch?: string;
  pr?: { url: string; number: number; mock: boolean; draft: boolean };
}

export interface Incident {
  id: string;
  title: string;
  description: string;
  severity: Severity;
  service?: string;
  environment?: string;
  logs?: string;
  source: string;
  status: IncidentStatus;
  createdAt: string;
  updatedAt: string;
  occurrences: number;
  repoTarget?: RepoTarget;
  timeline: TimelineEvent[];
  analysis?: { mode: 'ollama' | 'demo'; model?: string; generatedAt: string; result: Analysis };
  remediation?: Remediation;
  error?: string;
  owner?: string;
  resolvedAt?: string;
}

export interface IncidentSummary {
  id: string;
  title: string;
  severity: Severity;
  status: IncidentStatus;
  service?: string;
  environment?: string;
  source: string;
  occurrences: number;
  repoTarget?: RepoTarget;
  createdAt: string;
  updatedAt: string;
  analysisMode?: 'ollama' | 'demo';
  confidence?: number;
  remediationStatus?: RemediationStatus;
  prUrl?: string;
  owner?: string;
  resolvedAt?: string;
  /** When the PR/MR was opened. */
  fixedAt?: string;
  snippet: string;
  running: boolean;
}

export interface Health {
  ok: boolean;
  database: { ok: boolean };
  ai: {
    provider: string;
    model: string;
    baseUrl: string;
    numThread?: number | null;
    timeoutMinutes?: number;
    demoMode: boolean;
    reachable: boolean;
    modelAvailable: boolean;
  };
  github: { mode: 'github' | 'mock' | 'none'; repo: string | null; baseBranch: string | null; allowedPaths: string[]; missing: string[]; autoCreatePr: boolean };
  gitlab: { configured: boolean; url: string; repo: string | null; baseBranch: string | null; allowedPaths: string[]; missing: string[] };
  repos?: Array<{
    id: RepoTarget;
    provider: 'github' | 'gitlab' | 'mock' | 'none';
    name: string;
    baseBranch: string | null;
    webUrl: string | null;
    allowedPaths?: string[];
  }>;
  defaultRepo: RepoTarget | null;
  teams: { configured: boolean };
  webhooks: { secretConfigured: boolean };
}

export interface NewIncident {
  title: string;
  description: string;
  severity: Severity;
  service?: string;
  environment?: string;
  logs?: string;
  repo?: RepoTarget;
  owner?: string;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly details?: Record<string, string[]>) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('Cannot reach the Nagent backend. Is it running on port 8080?', 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = typeof data?.error === 'string' ? data.error : `Request failed (HTTP ${res.status})`;
    throw new ApiError(res.status >= 502 && res.status <= 504 && !data?.error ? 'Backend unavailable' : message, res.status, data?.details);
  }
  return data as T;
}

/** The operator name entered in Settings, sent with actions so the audit log says who did what. */
export function operatorName(): string | undefined {
  try {
    return localStorage.getItem('nagent.operator')?.trim() || undefined;
  } catch {
    return undefined;
  }
}

const enc = encodeURIComponent;
const withActor = <T extends object>(body?: T) => ({ ...body, actor: operatorName() });

export const api = {
  health: () => request<Health>('GET', '/health'),
  list: () => request<{ incidents: IncidentSummary[] }>('GET', '/incidents').then((d) => d.incidents),
  get: (id: string) => request<{ incident: Incident; running: boolean }>('GET', `/incidents/${encodeURIComponent(id)}`),
  create: (input: NewIncident) => request<{ incident: Incident }>('POST', '/incidents', input).then((d) => d.incident),
  investigate: (id: string, mode: 'ai' | 'demo') =>
    request<{ incident: Incident }>('POST', `/incidents/${encodeURIComponent(id)}/investigate`, { mode }),
  approve: (id: string) => request<{ incident: Incident }>('POST', `/incidents/${enc(id)}/approve`, withActor()),
  /** Stops a running investigation (the model request is aborted on the server). */
  cancel: (id: string) => request<{ incident: Incident; running: boolean }>('POST', `/incidents/${enc(id)}/cancel`, withActor()),
  remove: (id: string) => {
    const actor = operatorName();
    return request<{ deleted: string }>('DELETE', `/incidents/${enc(id)}${actor ? `?actor=${enc(actor)}` : ''}`);
  },
  reject: (id: string, reason?: string) => request<{ incident: Incident }>('POST', `/incidents/${enc(id)}/reject`, withActor({ reason })),
  resolve: (id: string, note?: string) => request<{ incident: Incident }>('POST', `/incidents/${enc(id)}/resolve`, withActor({ note })),
  reopen: (id: string) => request<{ incident: Incident }>('POST', `/incidents/${enc(id)}/reopen`, withActor()),
  assign: (id: string, owner: string | null) => request<{ incident: Incident }>('PATCH', `/incidents/${enc(id)}`, withActor({ owner })),
  audit: (limit = 500) => request<{ events: AuditEvent[] }>('GET', `/audit?limit=${limit}`).then((d) => d.events),
};
