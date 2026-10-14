# Nagent — backend

Express + TypeScript API. See the [project README](../README.md) for setup, configuration and the API.

```
src/
  index.ts            server entrypoint (initDb, listen on HOST:PORT)
  app.ts              express app, /api/health, error handling
  config.ts           environment configuration
  db.ts               SQLite persistence (node:sqlite)
  routes/incidents.ts incidents API (create, list, get, investigate, rca, approve)
  routes/webhooks.ts  authenticated alert / Teams intake
  services/ai.ts      Ollama analyzer, demo analyzer, schema validation, fact grounding
  services/repo.ts    GitHub + GitLab REST providers, mock repository, path policy
  services/patch.ts   file selection, patch application, static validation, RCA markdown
  services/pipeline.ts investigation + approval workflow
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
