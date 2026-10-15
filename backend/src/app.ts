import cors from 'cors';
import express, { type ErrorRequestHandler, type Request } from 'express';
import { config, configuredTargets, defaultTarget, githubConfigProblems, gitlabConfigProblems, repoById } from './config.js';
import { dbHealthy } from './db.js';
import { incidentsRouter } from './routes/incidents.js';
import { webhooksRouter } from './routes/webhooks.js';
import { ollamaStatus } from './services/ai.js';
import { getRepoProvider } from './services/repo.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // Only the local Vite dev server / same-origin pages may call the API from a browser.
  app.use(cors({ origin: [/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/] }));
  app.use(
    express.json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: Buffer }).rawBody = buf; // for webhook HMAC verification
      },
    }),
  );

  app.get('/api/health', async (_req, res) => {
    const ollama = config.demoMode ? undefined : await ollamaStatus();
    const repo = getRepoProvider('github');
    const gitlab = config.githubMock ? null : getRepoProvider('gitlab');
    const database = dbHealthy();
    // Configuration flags only — never tokens, secrets or webhook URLs.
    res.status(database ? 200 : 503).json({
      ok: database,
      service: 'nagent',
      database: { ok: database },
      ai: {
        provider: 'ollama',
        model: config.ollamaModel,
        baseUrl: config.ollamaBaseUrl,
        numThread: config.ollamaNumThread ?? null,
        timeoutMinutes: Math.round(config.aiTimeoutMs / 60_000),
        demoMode: config.demoMode,
        reachable: ollama?.reachable ?? false,
        modelAvailable: ollama?.modelAvailable ?? false,
      },
      github: {
        mode: repo?.kind ?? 'none',
        repo: repo?.name ?? null,
        baseBranch: repo?.baseBranch ?? null,
        allowedPaths: repo?.allowedPaths ?? [],
        missing: config.githubMock ? [] : githubConfigProblems(),
        autoCreatePr: config.autoCreatePr,
      },
      gitlab: {
        configured: Boolean(gitlab),
        url: repoById('gitlab')?.url ?? config.gitlabUrl,
        repo: gitlab?.name ?? null,
        baseBranch: gitlab?.baseBranch ?? null,
        allowedPaths: gitlab?.allowedPaths ?? [],
        missing: config.githubMock ? [] : gitlabConfigProblems(),
      },
      /** Every repository an incident can be reported against (ids for the form's picker and ?repo=). */
      repos: configuredTargets().map((id) => {
        const r = getRepoProvider(id);
        return { id, provider: r?.kind ?? 'none', name: r?.name ?? id, baseBranch: r?.baseBranch ?? null, webUrl: r?.webUrl || null };
      }),
      /** Repository used when an incident or alert does not choose one. */
      defaultRepo: defaultTarget() ?? null,
      teams: { configured: Boolean(config.teamsWebhookUrl) },
      webhooks: { secretConfigured: Boolean(config.webhookSecret) },
    });
  });

  app.use('/api/incidents', incidentsRouter);
  app.use('/api/webhooks', webhooksRouter);
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err?.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'Request body is not valid JSON' });
      return;
    }
    if (err?.type === 'entity.too.large') {
      res.status(413).json({ error: 'Request body too large' });
      return;
    }
    console.error('Unhandled error:', err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'Internal server error' });
  };
  app.use(onError);
  return app;
}
