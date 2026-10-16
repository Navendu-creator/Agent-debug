# Nagent — backend

Express + TypeScript API. See the [project README](../README.md) for setup, configuration and the API.

```
src/
  index.ts            server entrypoint (initDb, listen on HOST:PORT)
  app.ts              express app, /api/health, error handling
  config.ts           environment configuration
  db.ts               SQLite persistence (node:sqlite)
  routes/incidents.ts incidents API (create, list, get, investigate, rca, approve, cancel, reject,
                      resolve, reopen, assign, delete) and the audit log
  routes/webhooks.ts  authenticated alert / Teams intake
  services/ai.ts      Ollama analyzer, demo analyzer, schema validation, fact grounding
  services/repo.ts    GitHub + GitLab REST providers (files, commit history, PR/MR), mock repository, path policy
  services/patch.ts   file selection, static checks and fixes, history restore, patch application,
                      static validation, RCA markdown
  services/k8s.ts     Kubernetes API validation rules (kind, metadata.name, containers, init-container probes)
  services/pipeline.ts investigation + approval workflow; picks the model's or Nagent's fix
  services/teams.ts   optional Teams notifications
legacy/               previous clone-based agent (not compiled or used)
```

```bash
npm install
npm run dev        # watch mode
npm test           # e2e + unit tests (external services mocked)
npm run typecheck
npm run db:init
```
