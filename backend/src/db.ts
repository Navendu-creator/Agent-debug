import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import type { Incident, IncidentStatus, TimelineEvent } from './types.js';

/** One row of the audit log: a timeline event, or a record kept after its incident was deleted. */
export interface AuditEvent extends TimelineEvent {
  incidentId: string;
  incidentTitle: string;
  /** False when the incident has since been deleted. */
  exists: boolean;
}

/**
 * SQLite persistence (Node's built-in node:sqlite, no native build). Each incident is one row; the
 * full document is stored as JSON with a few indexed columns for listing and deduplication.
 */

let db: DatabaseSync | undefined;

export function initDb(url = config.databaseUrl): void {
  const path = url.replace(/^(file|sqlite):(\/\/)?/, '');
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
  db?.close();
  db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS incidents (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      fingerprint TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS incidents_created ON incidents(created_at);
    CREATE INDEX IF NOT EXISTS incidents_fingerprint ON incidents(fingerprint);
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      incident_id TEXT NOT NULL,
      incident_title TEXT NOT NULL,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      actor TEXT
    );
  `);
}

function conn(): DatabaseSync {
  if (!db) initDb();
  return db!;
}

export function dbHealthy(): boolean {
  try {
    conn().prepare('SELECT 1').get();
    return true;
  } catch {
    return false;
  }
}

export function saveIncident(incident: Incident): Incident {
  conn()
    .prepare(
      `INSERT INTO incidents (id, status, fingerprint, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, fingerprint = excluded.fingerprint,
         updated_at = excluded.updated_at, data = excluded.data`,
    )
    .run(
      incident.id,
      incident.status,
      incident.fingerprint ?? null,
      incident.createdAt,
      incident.updatedAt,
      JSON.stringify(incident),
    );
  return incident;
}

export function getIncident(id: string): Incident | undefined {
  const row = conn().prepare('SELECT data FROM incidents WHERE id = ?').get(id) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as Incident) : undefined;
}

export function listIncidents(limit = 200): Incident[] {
  const rows = conn()
    .prepare('SELECT data FROM incidents ORDER BY created_at DESC LIMIT ?')
    .all(limit) as Array<{ data: string }>;
  return rows.map((r) => JSON.parse(r.data) as Incident);
}

// Stopped or rejected incidents stay open: a repeated alert is attached to them instead of starting a new one.
const OPEN: IncidentStatus[] = ['open', 'investigating', 'rca_ready', 'awaiting_approval', 'creating_pr', 'cancelled', 'rejected'];

export function findOpenByFingerprint(fingerprint: string): Incident | undefined {
  const row = conn()
    .prepare(
      `SELECT data FROM incidents WHERE fingerprint = ? AND status IN (${OPEN.map(() => '?').join(',')})
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(fingerprint, ...OPEN) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as Incident) : undefined;
}

/** Read-modify-write of one incident. Safe because node:sqlite is synchronous (no interleaving). */
export function updateIncident(id: string, mutate: (incident: Incident) => void): Incident | undefined {
  const incident = getIncident(id);
  if (!incident) return undefined;
  mutate(incident);
  incident.updatedAt = new Date().toISOString();
  return saveIncident(incident);
}

/** Deletes the incident; its timeline and the deletion itself are kept in the audit log. */
export function deleteIncident(id: string, actor?: string): boolean {
  const incident = getIncident(id);
  if (!incident) return false;
  const insert = conn().prepare('INSERT INTO audit_log (at, incident_id, incident_title, type, message, actor) VALUES (?, ?, ?, ?, ?, ?)');
  const events: TimelineEvent[] = [
    ...incident.timeline,
    { at: new Date().toISOString(), type: 'status', message: `Incident deleted${actor ? ` by ${actor}` : ''}`, actor },
  ];
  for (const e of events) insert.run(e.at, id, incident.title, e.type, e.message, e.actor ?? null);
  return conn().prepare('DELETE FROM incidents WHERE id = ?').run(id).changes > 0;
}

export function addEvent(id: string, type: TimelineEvent['type'], message: string, actor?: string): Incident | undefined {
  return updateIncident(id, (incident) => {
    incident.timeline.push({ at: new Date().toISOString(), type, message: message.slice(0, 2000), ...(actor ? { actor } : {}) });
  });
}

/** Every timeline event of every incident plus deletion records, newest first. */
export function listAuditEvents(limit = 500): AuditEvent[] {
  const events: AuditEvent[] = listIncidents(1000).flatMap((i) =>
    i.timeline.map((e) => ({ ...e, incidentId: i.id, incidentTitle: i.title, exists: true })),
  );
  const rows = conn()
    .prepare('SELECT at, incident_id, incident_title, type, message, actor FROM audit_log ORDER BY at DESC LIMIT ?')
    .all(limit) as Array<{ at: string; incident_id: string; incident_title: string; type: TimelineEvent['type']; message: string; actor: string | null }>;
  for (const r of rows) {
    events.push({ at: r.at, type: r.type, message: r.message, actor: r.actor ?? undefined, incidentId: r.incident_id, incidentTitle: r.incident_title, exists: false });
  }
  return events.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

/** Work that was in flight when the server stopped will never finish; mark it so it can be retried. */
export function recoverInterrupted(): number {
  let count = 0;
  for (const incident of listIncidents(1000)) {
    if (incident.status === 'investigating') {
      updateIncident(incident.id, (i) => {
        i.status = 'failed';
        i.error = 'Investigation interrupted by a server restart. Retry the investigation.';
        i.timeline.push({ at: new Date().toISOString(), type: 'error', message: i.error });
      });
      count++;
    } else if (incident.status === 'creating_pr' && incident.remediation) {
      updateIncident(incident.id, (i) => {
        i.status = 'awaiting_approval';
        i.remediation!.status = 'pr_failed';
        i.remediation!.message = 'PR creation interrupted by a server restart. Approve again to retry.';
      });
      count++;
    }
  }
  return count;
}
