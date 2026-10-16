import { createHash } from 'node:crypto';
import { customAlphabet } from 'nanoid';
import { defaultTarget } from '../config.js';
import { addEvent, findOpenByFingerprint, getIncident, saveIncident, updateIncident } from '../db.js';
import type { CreateIncidentInput, Incident, Severity } from '../types.js';
import { notifyReceived, startInvestigation } from './pipeline.js';

const nanoid = customAlphabet('0123456789ABCDEFGHJKLMNPQRSTUVWXYZ', 6);

function newIncidentId(): string {
  let id: string;
  do id = `INC-${nanoid()}`;
  while (getIncident(id));
  return id;
}

/** Maps alert/legacy severities (P1, sev2, warning, fatal…) onto the four internal levels. */
export function normalizeSeverity(value: unknown): Severity {
  const s = String(value ?? '').trim().toLowerCase();
  if (/^(critical|crit|fatal|emergency|emerg|page|p1|sev ?1|s1|outage)$/.test(s)) return 'critical';
  if (/^(high|error|err|major|p2|sev ?2|s2|alert)$/.test(s)) return 'high';
  if (/^(low|info|informational|minor|p4|sev ?4|s4|notice)$/.test(s)) return 'low';
  return 'medium';
}

/**
 * Normalizes volatile parts of an error message (ids, numbers, timestamps, hex) so the same
 * error reported many times produces the same fingerprint.
 */
export function fingerprintError(service: string, message: string): string {
  const normalized = message
    .toLowerCase()
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<uuid>')
    .replace(/\b0x[0-9a-f]+\b/g, '<hex>')
    .replace(/\d{4}-\d{2}-\d{2}[t ][\d:.]+z?/g, '<ts>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
  return createHash('sha256').update(`${service}\n${normalized}`).digest('hex').slice(0, 16);
}

export interface IntakeResult {
  incident: Incident;
  /** True when the report was attached to an already-open incident instead of creating a new one. */
  deduplicated: boolean;
}

/**
 * Single entry point for every intake channel (web form, alert/log/Teams webhooks). Persists the
 * incident and starts the investigation in the background — callers return immediately.
 */
export function intakeIncident(input: CreateIncidentInput, opts: { investigate?: boolean } = {}): IntakeResult {
  const source = input.source ?? 'web';

  if (input.fingerprint) {
    const existing = findOpenByFingerprint(input.fingerprint);
    if (existing) {
      const updated = updateIncident(existing.id, (i) => {
        i.occurrences += 1;
      })!;
      addEvent(existing.id, 'intake', `Same alert received again from ${source} (occurrence ${updated.occurrences})`);
      return { incident: getIncident(existing.id)!, deduplicated: true };
    }
  }

  const now = new Date().toISOString();
  const incident: Incident = {
    id: newIncidentId(),
    title: input.title.slice(0, 200),
    description: (input.description ?? '').slice(0, 8000),
    severity: input.severity ?? 'medium',
    service: input.service || undefined,
    environment: input.environment || undefined,
    logs: input.logs ? input.logs.slice(0, 20_000) : undefined,
    source,
    status: 'open',
    createdAt: now,
    updatedAt: now,
    occurrences: 1,
    fingerprint: input.fingerprint,
    repoTarget: input.repoTarget ?? defaultTarget(),
    owner: input.owner || undefined,
    timeline: [{ at: now, type: 'intake', message: `Incident received from ${source}` }],
  };
  saveIncident(incident);
  // Teams is notified first; the investigation starts once the notification has been sent.
  if (opts.investigate === false) notifyReceived(incident.id);
  else startInvestigation(incident.id, { announce: true });
  return { incident: getIncident(incident.id)!, deduplicated: false };
}
