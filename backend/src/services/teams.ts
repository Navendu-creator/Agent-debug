import { config } from '../config.js';
import type { Incident } from '../types.js';

/**
 * Optional Microsoft Teams notifications through a Teams Workflows / Power Automate webhook.
 * The payload is a Teams `message` with an Adaptive Card attachment — the format the standard
 * "Post to a channel when a webhook request is received" workflow posts. The extra top-level fields
 * (incidentId, rootCause, prUrl, …) are for custom flows that map them individually.
 * Skipped silently when TEAMS_WEBHOOK_URL is not set; failures never break the pipeline.
 */

export type TeamsEvent = 'incident_received' | 'rca_ready' | 'pr_created' | 'investigation_failed';

const HEADLINES: Record<TeamsEvent, string> = {
  incident_received: '🎫 New incident',
  rca_ready: '🔍 RCA ready',
  pr_created: '✅ Pull/merge request created',
  investigation_failed: '❌ Investigation failed',
};

function adaptiveCard(event: TeamsEvent, incident: Incident, title: string) {
  const a = incident.analysis?.result;
  const r = incident.remediation;
  const pr = r?.pr;
  const facts = [
    { title: 'Incident', value: incident.title },
    { title: 'Severity', value: incident.severity },
    { title: 'Service', value: incident.service },
    { title: 'Environment', value: incident.environment },
    { title: 'Source', value: incident.source },
    { title: 'Status', value: incident.status },
    event === 'rca_ready' && a ? { title: 'Confidence', value: `${a.confidence}%${incident.analysis!.mode === 'demo' ? ' (DEMO — not AI)' : ''}` } : undefined,
    event === 'rca_ready' && r ? { title: 'Proposed change', value: r.changes.filter((c) => !c.path.startsWith('docs/')).map((c) => c.path).join(', ') || 'RCA only' } : undefined,
    pr ? { title: 'Branch', value: r?.branch } : undefined,
  ].filter((f): f is { title: string; value: string } => Boolean(f?.value));

  const detail =
    event === 'incident_received'
      ? incident.description || incident.logs || ''
      : event === 'rca_ready' && a
        ? `**Probable root cause:** ${a.probableRootCause}\n\n**Recommended fix:** ${a.recommendedFix}`
        : event === 'investigation_failed'
          ? `**Error:** ${incident.error ?? 'unknown'}`
          : pr?.mock
            ? 'Mock PR — created in the in-memory test repository, not on GitHub.'
            : '';

  const realPr = pr && !pr.mock && /^https:\/\//.test(pr.url);
  const ref = r?.provider === 'gitlab' ? `MR !${pr?.number}` : `PR #${pr?.number}`;
  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.4',
    body: [
      {
        type: 'TextBlock',
        text: title,
        weight: 'Bolder',
        size: 'Medium',
        wrap: true,
        color: event === 'investigation_failed' || incident.severity === 'critical' ? 'Attention' : 'Default',
      },
      { type: 'FactSet', facts },
      ...(detail ? [{ type: 'TextBlock', text: detail.slice(0, 1500), wrap: true }] : []),
    ],
    actions: realPr ? [{ type: 'Action.OpenUrl', title: `Open ${ref}`, url: pr!.url }] : [],
  };
}

export function teamsPayload(event: TeamsEvent, incident: Incident) {
  const a = incident.analysis?.result;
  const pr = incident.remediation?.pr;
  const lines = [
    `**${incident.id}** — ${incident.title}`,
    `Severity: ${incident.severity}${incident.service ? ` · Service: ${incident.service}` : ''}${
      incident.environment ? ` · Env: ${incident.environment}` : ''
    }`,
    event === 'rca_ready' && a
      ? `${incident.analysis!.mode === 'demo' ? '[DEMO] ' : ''}Root cause (${a.confidence}% confidence): ${a.probableRootCause}`
      : '',
    event === 'pr_created' && pr ? `${incident.remediation?.provider === 'gitlab' ? 'MR' : 'PR'}: ${pr.url}${pr.mock ? ' (mock — not a real PR)' : ''}` : '',
    event === 'investigation_failed' && incident.error ? `Error: ${incident.error}` : '',
  ].filter(Boolean);

  const title = `${HEADLINES[event]}: ${incident.id}`;
  return {
    type: 'message',
    attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: adaptiveCard(event, incident, title) }],
    kind: event === 'incident_received' ? 'incident_ticket' : 'incident_update',
    event,
    title,
    text: `${title}\n\n${lines.join('\n')}`.slice(0, 3000),
    incidentId: incident.id,
    severity: incident.severity,
    status: incident.status,
    service: incident.service ?? null,
    environment: incident.environment ?? null,
    rootCause: a?.probableRootCause ?? null,
    prUrl: pr?.url ?? null,
    error: incident.error ?? null,
    // Fields from the previous DebugAssist payload, kept so existing Power Automate flows still work.
    summary: title,
    source: incident.source,
    description: incident.description,
    repoUrl: incident.remediation?.repoUrl ?? (incident.remediation?.provider === 'github' ? `https://github.com/${incident.remediation.repo}` : null),
    createdAt: incident.createdAt,
    updatedAt: incident.updatedAt,
    branch: incident.remediation?.branch ?? null,
    fix: a?.recommendedFix ?? null,
    tests: incident.remediation
      ? incident.remediation.checks.map((c) => `${c.status}: ${c.name} ${c.file ?? ''}`.trim()).join('\n')
      : null,
    testsPassed: incident.remediation ? incident.remediation.checks.every((c) => c.status !== 'failed') : null,
    summaryText: a?.summary ?? null,
    themeColor: event === 'investigation_failed' || incident.severity === 'critical' ? 'E85D4C' : '00A896',
  };
}

export async function notifyTeams(event: TeamsEvent, incident: Incident): Promise<{ ok: boolean; detail: string }> {
  if (!config.teamsWebhookUrl) return { ok: false, detail: 'TEAMS_WEBHOOK_URL not configured (skipped)' };
  try {
    const res = await fetch(config.teamsWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(teamsPayload(event, incident)),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok ? { ok: true, detail: 'sent' } : { ok: false, detail: `Teams webhook HTTP ${res.status}` };
  } catch (err) {
    // The webhook URL embeds a credential — never include it in the message.
    return { ok: false, detail: `Teams webhook unreachable (${err instanceof Error ? err.name : 'error'})` };
  }
}
