export type Severity = 'critical' | 'high' | 'medium' | 'low';

export type IncidentStatus =
  | 'open'
  | 'investigating'
  | 'rca_ready'
  | 'awaiting_approval'
  | 'creating_pr'
  | 'pr_created'
  | 'failed';

export interface TimelineEvent {
  at: string;
  type: 'intake' | 'analysis' | 'repo' | 'patch' | 'validation' | 'pr' | 'notify' | 'error' | 'info';
  message: string;
}

/** `fact` items carry a quote that was verified to appear in the incident data or repository files. */
export interface Evidence {
  type: 'fact' | 'hypothesis';
  statement: string;
  quote?: string;
  /** Where a fact's quote was found: the incident report (a claim) or the repository (the code). */
  source?: 'report' | 'repository';
}

/** A model-proposed exact search/replace edit on a repository file it was shown. */
export interface ProposedChange {
  file: string;
  description: string;
  find: string;
  replace: string;
}

export interface Analysis {
  summary: string;
  probableRootCause: string;
  evidence: Evidence[];
  confidence: number;
  recommendedFix: string;
  preventiveActions: string[];
  proposedChanges: ProposedChange[];
  validationPlan: string[];
  limitations: string[];
}

export interface AnalysisRecord {
  mode: 'ollama' | 'demo';
  model?: string;
  generatedAt: string;
  result: Analysis;
}

export interface FileChange {
  path: string;
  description: string;
  diff: string;
  /** Server-side only (stripped from API responses). */
  before?: string;
  after?: string;
}

export interface ValidationCheck {
  name: string;
  file?: string;
  status: 'passed' | 'failed' | 'skipped';
  detail: string;
}

export type RemediationStatus =
  | 'not_configured'
  | 'blocked'
  | 'validation_failed'
  | 'awaiting_approval'
  | 'creating_pr'
  | 'pr_created'
  | 'pr_failed';

export interface Remediation {
  status: RemediationStatus;
  provider: 'github' | 'gitlab' | 'mock' | 'none';
  repo?: string;
  repoUrl?: string;
  baseBranch?: string;
  changes: FileChange[];
  /** Model suggestions that were not applied, with the reason. */
  rejected: Array<{ file: string; reason: string }>;
  checks: ValidationCheck[];
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
  /** Repeated alerts with the same fingerprint attach to the open incident. */
  fingerprint?: string;
  /** Repository the incident is investigated and fixed against; unset = default target. */
  repoTarget?: 'github' | 'gitlab';
  timeline: TimelineEvent[];
  analysis?: AnalysisRecord;
  remediation?: Remediation;
  error?: string;
}

export interface CreateIncidentInput {
  title: string;
  description?: string;
  severity?: Severity;
  service?: string;
  environment?: string;
  logs?: string;
  source?: string;
  fingerprint?: string;
  repoTarget?: 'github' | 'gitlab';
}
