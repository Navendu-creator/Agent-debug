import { Router } from 'express';
import { z } from 'zod';
import { getIncident, listIncidents } from '../db.js';
import { intakeIncident, normalizeSeverity } from '../services/incidents.js';
import { ApprovalError, approveAndCreatePr, isRunning, startInvestigation } from '../services/pipeline.js';
import type { Incident } from '../types.js';

const optionalText = (max: number) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().max(max).optional());

const createSchema = z.object({
  title: z.string().trim().min(3, 'Title must be at least 3 characters').max(200),
  description: z.string().trim().max(8000).optional().default(''),
  severity: z
    .preprocess((v) => (v === undefined ? 'medium' : normalizeSeverity(v)), z.enum(['critical', 'high', 'medium', 'low'])),
  service: optionalText(120),
  environment: optionalText(60),
  logs: optionalText(20_000),
});

const investigateSchema = z.object({ mode: z.enum(['ai', 'demo']).optional().default('ai') }).default({});

/** Strips server-only data (full file contents) from API responses. */
export function toPublic(incident: Incident): Incident {
  if (!incident.remediation) return incident;
  return {
    ...incident,
    remediation: {
      ...incident.remediation,
      changes: incident.remediation.changes.map(({ before: _b, after: _a, ...rest }) => rest),
    },
  };
}

function summary(i: Incident) {
  return {
    id: i.id,
    title: i.title,
    severity: i.severity,
    status: i.status,
    service: i.service,
    environment: i.environment,
    source: i.source,
    occurrences: i.occurrences,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
    analysisMode: i.analysis?.mode,
    confidence: i.analysis?.result.confidence,
    remediationStatus: i.remediation?.status,
    prUrl: i.remediation?.pr?.url,
    running: isRunning(i.id),
  };
}

export const incidentsRouter = Router();

incidentsRouter.get('/', (_req, res) => {
  res.json({ incidents: listIncidents().map(summary) });
});

incidentsRouter.post('/', (req, res) => {
  const parsed = createSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid incident', details: parsed.error.flatten().fieldErrors });
    return;
  }
  const { incident } = intakeIncident({ ...parsed.data, source: 'web' });
  res.status(201).json({ incident: toPublic(incident) });
});

incidentsRouter.get('/:id', (req, res) => {
  const incident = getIncident(req.params.id);
  if (!incident) {
    res.status(404).json({ error: 'Incident not found' });
    return;
  }
  res.json({ incident: toPublic(incident), running: isRunning(incident.id) });
});

incidentsRouter.get('/:id/rca', (req, res) => {
  const incident = getIncident(req.params.id);
  if (!incident) {
    res.status(404).json({ error: 'Incident not found' });
    return;
  }
  if (!incident.analysis) {
    res.status(404).json({ error: 'RCA not available yet', status: incident.status });
    return;
  }
  const { remediation } = toPublic(incident);
  res.json({ incidentId: incident.id, analysis: incident.analysis, remediation: remediation ?? null });
});

incidentsRouter.post('/:id/investigate', (req, res) => {
  const incident = getIncident(req.params.id);
  if (!incident) {
    res.status(404).json({ error: 'Incident not found' });
    return;
  }
  const parsed = investigateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'mode must be "ai" or "demo"' });
    return;
  }
  if (incident.status === 'pr_created') {
    res.status(409).json({ error: 'A PR was already created for this incident' });
    return;
  }
  if (!startInvestigation(incident.id, { demo: parsed.data.mode === 'demo' })) {
    res.status(409).json({ error: 'An investigation is already running for this incident' });
    return;
  }
  res.status(202).json({ incident: toPublic(getIncident(incident.id)!), running: true });
});

incidentsRouter.post('/:id/approve', async (req, res, next) => {
  try {
    const incident = await approveAndCreatePr(req.params.id);
    res.json({ incident: toPublic(incident) });
  } catch (err) {
    if (err instanceof ApprovalError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    next(err);
  }
});
