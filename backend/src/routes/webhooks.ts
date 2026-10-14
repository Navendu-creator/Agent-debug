import { createHmac, timingSafeEqual } from 'node:crypto';
import { Router, type Request, type RequestHandler } from 'express';
import { config, configuredTargets, type RepoTarget } from '../config.js';
import { fingerprintError, intakeIncident, normalizeSeverity, type IntakeResult } from '../services/incidents.js';
import type { CreateIncidentInput } from '../types.js';

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Webhook authentication. Accepts either
 *  - `X-Nagent-Signature: sha256=<hex HMAC-SHA256 of the raw body, keyed with WEBHOOK_SIGNING_SECRET>`
 *  - `Authorization: Bearer <WEBHOOK_SIGNING_SECRET>` (or `X-Intake-Token`) for tools that cannot sign.
 * Rejects everything when no secret is configured.
 */
export const requireWebhookAuth: RequestHandler = (req, res, next) => {
  const secret = config.webhookSecret;
  if (!secret) {
    res.status(503).json({ error: 'Webhook authentication is not configured (set WEBHOOK_SIGNING_SECRET on the server)' });
    return;
  }
  const signature = req.get('x-nagent-signature') ?? req.get('x-opspilot-signature');
  if (signature) {
    const raw = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
    const expected = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
    if (safeEqual(signature, expected)) return next();
  } else {
    const token = req.get('authorization')?.replace(/^Bearer\s+/i, '') ?? req.get('x-intake-token');
    if (token && safeEqual(token, secret)) return next();
  }
  res.status(401).json({ error: 'Invalid or missing webhook signature' });
};

function str(value: unknown, max = 8000): string {
  if (value == null) return '';
  return (typeof value === 'string' ? value : JSON.stringify(value)).trim().slice(0, max);
}

function logsText(value: unknown): string {
  return Array.isArray(value) ? value.map((v) => str(v, 2000)).join('\n') : str(value, 20_000);
}

/**
 * Normalizes one alert into the incident format. Supports the simple Nagent shape
 * ({ alertname, severity, description, service, environment, timestamp, logs }) and
 * Prometheus Alertmanager / Grafana alerts ({ status, labels, annotations, startsAt }).
 */
export function normalizeAlert(alert: Record<string, any>): CreateIncidentInput | { error: string } | null {
  const labels = (alert.labels ?? {}) as Record<string, unknown>;
  const ann = (alert.annotations ?? {}) as Record<string, unknown>;
  if (alert.status && alert.status !== 'firing') return null; // resolved alerts don't open incidents

  const alertname = str(alert.alertname ?? labels.alertname, 200);
  if (!alertname) return { error: 'alertname is required' };
  const service = str(alert.service ?? labels.service ?? labels.job ?? labels.app, 120) || undefined;
  const environment = str(alert.environment ?? labels.environment ?? labels.env ?? labels.cluster, 60) || undefined;
  const description = str(alert.description ?? ann.description ?? ann.summary);
  const timestamp = str(alert.timestamp ?? alert.startsAt, 60);

  return {
    title: `${service ? `[${service}] ` : ''}${alertname}`.slice(0, 200),
    description: [description, timestamp ? `Alert fired at: ${timestamp}` : ''].filter(Boolean).join('\n\n'),
    severity: normalizeSeverity(alert.severity ?? labels.severity),
    service,
    environment,
    logs: logsText(alert.logs) || undefined,
    source: 'alert-webhook',
    fingerprint: fingerprintError(service ?? 'unknown', `${environment ?? ''}:${alertname}`),
  };
}

/**
 * Optional `?repo=<id>` (github, gitlab, github-2…) on webhook URLs routes the incident to that repository.
 * Returns undefined (default target) when absent, or an error message when invalid/unconfigured.
 */
function repoParam(req: Request): { repo?: RepoTarget; error?: string } {
  const value = req.query.repo;
  if (value === undefined || value === '') return {};
  if (typeof value !== 'string' || !configuredTargets().includes(value)) {
    return { error: `repo must be one of the configured repositories: ${configuredTargets().join(', ') || 'none'}` };
  }
  return { repo: value };
}

const intakeSummary = (r: IntakeResult) => ({ id: r.incident.id, status: r.incident.status, deduplicated: r.deduplicated });

export const webhooksRouter = Router();
webhooksRouter.use(requireWebhookAuth);

/**
 * Generic alert intake: a single alert, an array of alerts, or an Alertmanager-style { alerts: [...] }.
 * Responds immediately with 202; investigations run in the background.
 */
webhooksRouter.post('/alerts', (req, res) => {
  const { repo, error } = repoParam(req);
  if (error) {
    res.status(400).json({ error });
    return;
  }
  const body = req.body as unknown;
  const alerts: unknown[] = Array.isArray(body)
    ? body
    : body && typeof body === 'object' && Array.isArray((body as Record<string, unknown>).alerts)
      ? ((body as Record<string, unknown>).alerts as unknown[])
      : [body];

  if (alerts.length === 0 || alerts.length > 50) {
    res.status(400).json({ error: 'Send between 1 and 50 alerts' });
    return;
  }
  const normalized = alerts.map((a) => (a && typeof a === 'object' ? normalizeAlert(a as Record<string, any>) : { error: 'alert must be an object' }));
  const invalid = normalized.find((n): n is { error: string } => Boolean(n && 'error' in n));
  if (invalid) {
    res.status(400).json({ error: invalid.error });
    return;
  }
  const incidents = normalized
    .filter((n): n is CreateIncidentInput => Boolean(n))
    // The same alert for a different repository is a different incident, so the fingerprint includes it.
    .map((n) => (repo ? { ...n, repoTarget: repo, fingerprint: `${repo}:${n.fingerprint}` } : n))
    .map((n) => intakeSummary(intakeIncident(n)));
  res.status(202).json({ accepted: incidents.length, ignored: alerts.length - incidents.length, incidents });
});

/** Microsoft Teams / Power Automate intake (kept from the previous version): { title?, text }. */
webhooksRouter.post('/teams', (req, res) => {
  const { repo, error } = repoParam(req);
  if (error) {
    res.status(400).json({ error });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const text = str(body.text ?? body.message ?? body.body);
  const title = str(body.title ?? body.subject, 200) || text.split('\n').find((l) => l.trim())?.trim().slice(0, 200) || '';
  if (title.length < 3) {
    res.status(400).json({ error: 'title or text is required' });
    return;
  }
  const result = intakeIncident({
    title,
    description: text,
    severity: normalizeSeverity(body.severity),
    source: 'teams',
    repoTarget: repo,
  });
  res.status(202).json(intakeSummary(result));
});
