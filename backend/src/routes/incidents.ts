import { Router } from 'express';
import { z } from 'zod';
import { configuredTargets } from '../config.js';
import { getIncident, listAuditEvents, listIncidents } from '../db.js';
import { intakeIncident, normalizeSeverity } from '../services/incidents.js';
import {
  ActionError,
  ApprovalError,
  approveAndCreatePr,
  assignOwner,
  cancelInvestigation,
  isRunning,
  rejectPatch,
  removeIncident,
  reopenIncident,
  resolveIncident,
  startInvestigation,
} from '../services/pipeline.js';
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
  /** Which configured repository to investigate and fix; omitted = the default one. */
  repo: z.preprocess((v) => (v === '' || v === null ? undefined : v), z.string().trim().max(60).optional()),
  owner: optionalText(60),
});

/** Who performed an action: a self-declared operator name (there is no login), recorded in the timeline. */
const actorSchema = z.object({ actor: optionalText(60) }).passthrough();
const reasonSchema = actorSchema.extend({ reason: optionalText(500), note: optionalText(500) });
const patchSchema = actorSchema.extend({ owner: z.preprocess((v) => (v === '' ? null : v), z.string().trim().max(60).nullable()) });

function actorOf(body: unknown): string | undefined {
  const parsed = actorSchema.safeParse(body ?? {});
  return parsed.success ? parsed.data.actor : undefined;
}

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
    repoTarget: i.repoTarget,
    occurrences: i.occurrences,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
    analysisMode: i.analysis?.mode,
    confidence: i.analysis?.result.confidence,
    remediationStatus: i.remediation?.status,
    prUrl: i.remediation?.pr?.url,
    owner: i.owner,
    resolvedAt: i.resolvedAt,
    /** When the pull/merge request was opened (for time-to-fix). */
    fixedAt: i.timeline.find((e) => e.type === 'pr' && /(PR #|MR !)\d+ created/.test(e.message))?.at,
    /** First line of the description, or the first log line, for list views. */
    snippet: (i.description.split('\n').find((l) => l.trim()) ?? i.logs?.split('\n').find((l) => l.trim()) ?? '').trim().slice(0, 160),
    running: isRunning(i.id),
  };
}

/** Maps ActionError/ApprovalError to their HTTP status; anything else is a 500. */
function respond(res: import('express').Response, next: import('express').NextFunction, err: unknown) {
  if (err instanceof ActionError || err instanceof ApprovalError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  next(err);
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
  const { repo, ...input } = parsed.data;
  if (repo && !configuredTargets().includes(repo)) {
    res.status(400).json({ error: `Repository "${repo}" is not configured on the server`, details: { repo: [`"${repo}" is not configured`] } });
    return;
  }
  const { incident } = intakeIncident({ ...input, repoTarget: repo, source: 'web' });
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
  if (incident.status === 'resolved') {
    res.status(409).json({ error: 'The incident is resolved — reopen it first' });
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
    const incident = await approveAndCreatePr(req.params.id, actorOf(req.body));
    res.json({ incident: toPublic(incident) });
  } catch (err) {
    if (err instanceof ApprovalError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    next(err);
  }
});

incidentsRouter.post('/:id/cancel', async (req, res, next) => {
  try {
    const incident = await cancelInvestigation(req.params.id, actorOf(req.body));
    res.json({ incident: toPublic(incident), running: isRunning(incident.id) });
  } catch (err) {
    if (err instanceof ActionError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    next(err);
  }
});

incidentsRouter.delete('/:id', async (req, res, next) => {
  try {
    await removeIncident(req.params.id, typeof req.query.actor === 'string' ? req.query.actor.trim().slice(0, 60) || undefined : undefined);
    res.json({ deleted: req.params.id });
  } catch (err) {
    if (err instanceof ActionError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    next(err);
  }
});

incidentsRouter.post('/:id/reject', (req, res, next) => {
  const parsed = reasonSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten().fieldErrors });
    return;
  }
  try {
    res.json({ incident: toPublic(rejectPatch(req.params.id, parsed.data.actor, parsed.data.reason)) });
  } catch (err) {
    respond(res, next, err);
  }
});

incidentsRouter.post('/:id/resolve', (req, res, next) => {
  const parsed = reasonSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten().fieldErrors });
    return;
  }
  try {
    res.json({ incident: toPublic(resolveIncident(req.params.id, parsed.data.actor, parsed.data.note)) });
  } catch (err) {
    respond(res, next, err);
  }
});

incidentsRouter.post('/:id/reopen', (req, res, next) => {
  try {
    res.json({ incident: toPublic(reopenIncident(req.params.id, actorOf(req.body))) });
  } catch (err) {
    respond(res, next, err);
  }
});

/** Updates editable fields (currently the owner). */
incidentsRouter.patch('/:id', (req, res, next) => {
  const parsed = patchSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten().fieldErrors });
    return;
  }
  try {
    res.json({ incident: toPublic(assignOwner(req.params.id, parsed.data.owner ?? undefined, parsed.data.actor)) });
  } catch (err) {
    respond(res, next, err);
  }
});

/** Audit log: every timeline event across incidents (plus deletions), newest first. */
export const auditRouter = Router();
auditRouter.get('/', (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 300, 1), 2000);
  res.json({ events: listAuditEvents(limit) });
});
