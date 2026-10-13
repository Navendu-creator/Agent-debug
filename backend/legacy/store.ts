import type { Incident, IncidentEvent, IncidentStatus } from './types.js';

const incidents = new Map<string, Incident>();

const OPEN_STATUSES: IncidentStatus[] = ['queued', 'ticketed', 'investigating', 'fixing'];

export function listIncidents(): Incident[] {
  return [...incidents.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getIncident(id: string): Incident | undefined {
  return incidents.get(id);
}

export function hasIncident(id: string): boolean {
  return incidents.has(id);
}

/** Open (not yet fixed / failed) incident with the same fingerprint, if any. */
export function findOpenByFingerprint(fingerprint: string): Incident | undefined {
  for (const incident of incidents.values()) {
    if (incident.fingerprint === fingerprint && OPEN_STATUSES.includes(incident.status)) {
      return incident;
    }
  }
  return undefined;
}

export function saveIncident(incident: Incident): Incident {
  incidents.set(incident.id, incident);
  return incident;
}

export function appendEvent(id: string, type: string, message: string): Incident | undefined {
  const incident = incidents.get(id);
  if (!incident) return undefined;
  const event: IncidentEvent = { at: new Date().toISOString(), type, message };
  incident.timeline.push(event);
  incident.updatedAt = event.at;
  incidents.set(id, incident);
  return incident;
}

export function updateIncident(
  id: string,
  patch: Partial<Omit<Incident, 'id' | 'timeline'>> & { status?: IncidentStatus },
): Incident | undefined {
  const incident = incidents.get(id);
  if (!incident) return undefined;
  Object.assign(incident, patch, { updatedAt: new Date().toISOString() });
  incidents.set(id, incident);
  return incident;
}
