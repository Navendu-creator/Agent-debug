import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import type { Incident, IncidentStatus, TimelineEvent } from './types.js';

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

const OPEN: IncidentStatus[] = ['open', 'investigating', 'rca_ready', 'awaiting_approval', 'creating_pr'];

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

export function addEvent(id: string, type: TimelineEvent['type'], message: string): Incident | undefined {
  return updateIncident(id, (incident) => {
    incident.timeline.push({ at: new Date().toISOString(), type, message: message.slice(0, 2000) });
  });
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
