# Nagent

A small, local incident-investigation tool. An engineer reports an incident (web UI or alert
webhook); Nagent analyzes it with a **local Ollama model**, produces a root-cause analysis that
separates verified facts from hypotheses, proposes a minimal patch against your GitHub repository,
validates it, and — **after you approve** — opens a pull request.

```
report (UI / webhook) ─► SQLite ─► read relevant repo files ─► Ollama analysis (JSON, schema-validated)
   ─► fact grounding ─► RCA ─► patch (exact search/replace on allowed paths) ─► static validation
   ─► [Approve] ─► new branch nagent/inc-… ─► one commit ─► PR against GITHUB_BASE_BRANCH
                                        Teams notifications at each step (optional)
```

| Part | Tech |
|---|---|
| `backend/` | Node.js 22, Express, TypeScript (tsx), zod, SQLite via built-in `node:sqlite` |
| `project/` | React 18, Vite, Tailwind |
| AI | Ollama (`/api/chat` with JSON-schema structured output) |
| GitHub | REST API (Git Data API for branch + commit, Pulls API for the PR) |

## Prerequisites

- **Node.js 22.13+** (for `node:sqlite` without flags) and npm
- **Ollama** for real AI analysis (optional — demo mode works without it)
- Optional: a GitHub fine-grained token, a Teams/Power Automate webhook URL

## Install

```bash
npm install                    # root helper (concurrently)
npm --prefix backend install
npm --prefix project install
cp backend/.env.example backend/.env   # only if you don't have a .env yet — then edit it
```

## Run

```bash
npm run dev          # backend on http://127.0.0.1:8080 + frontend on http://127.0.0.1:5173
# or separately:
npm run backend      # npm --prefix backend run dev
npm run frontend     # npm --prefix project run dev
```

Open http://127.0.0.1:5173. The header shows live status for Ollama, GitHub and Teams (from `GET /api/health`).

### Database

SQLite at `DATABASE_URL` (default `file:./data/opspilot.db`, relative to `backend/`). The schema is
created automatically on startup; to create it explicitly: `npm --prefix backend run db:init`.
Delete the file to reset. Investigations interrupted by a restart are marked failed and can be retried.

## Run with Docker

Needs only Docker with Compose (no Node.js or Ollama on the host). Runs three containers: `web`
(nginx serving the built UI and proxying `/api`), `backend`, and `ollama`.

```bash
cp backend/.env.example backend/.env   # fill in GitHub / Teams / webhook settings
docker compose up -d --build           # first start downloads OLLAMA_MODEL (~5 GB for qwen3:8b)
docker compose logs -f ollama-pull     # follow the model download
```

Open http://127.0.0.1:5173. `backend/.env` is shared with the non-Docker setup; inside Docker,
`HOST`, `PORT`, `DATABASE_URL` and `OLLAMA_BASE_URL` are overridden. The database lives in the
`nagent-data` volume and the models in the `ollama` volume, so `docker compose down` keeps both
(`down -v` deletes them).

Optional settings go in a `.env` file in the repository root:

| Variable | Default | Purpose |
|---|---|---|
| `WEB_PORT` | `5173` | Host port of the web UI |
| `WEB_BIND` | `127.0.0.1` | `0.0.0.0` to accept webhooks from other machines — the API has no login, so anyone who can reach it can approve PRs |
| `OLLAMA_MODELS_DIR` | `ollama` volume | Reuse existing models, e.g. `/usr/share/ollama/.ollama/models` for a Linux host install |

Stop `npm run dev` first: both use port 5173.

## Ollama

```bash
# Linux: curl -fsSL https://ollama.com/install.sh | sh     (macOS/Windows: https://ollama.com/download)
ollama serve                   # if not already running as a service
ollama pull qwen3:8b           # default model; set OLLAMA_MODEL to use another
```

`OLLAMA_BASE_URL` (default `http://127.0.0.1:11434`) and `OLLAMA_MODEL` are read from `backend/.env`.
On a CPU-only machine `qwen3:8b` takes roughly 3–5 minutes per analysis; smaller models
(`qwen3:4b`, `llama3.2:3b`) are faster but less accurate. Raise `AI_TIMEOUT_MS` if needed.
`qwen3:8b` needs about 6–8 GB of free RAM. `OLLAMA_NUM_CTX` (default 8192) sets the context window;
raising it costs memory. If the OS kills Ollama for lack of RAM, the investigation fails with a clear error.
`OLLAMA_NUM_THREAD` sets the CPU threads the model uses. Unset, Ollama picks the number of performance
cores — on hybrid Intel laptop CPUs (e.g. i5-1235U: 2 P-cores + 8 E-cores) that is only 2, which is very slow.

If Ollama is down or the model is missing, the investigation **fails with a clear error** — it never
fabricates a result. You can then click **Run demo analysis**: a keyword heuristic, labeled
"DEMO MODE" everywhere, that never proposes code changes and can't open a real PR.
`DEMO_MODE=true` forces demo analysis for every incident.

### How "facts vs hypotheses" works

The model must put an exact quote next to every *fact*. Nagent checks that the quote (or the
statement itself) appears verbatim in the incident report or the repository files it supplied; any
fact that fails this check is downgraded to a hypothesis and noted in *Limitations*.

## GitHub

1. Create a **fine-grained token** limited to one repository with *Contents: Read and write* and
   *Pull requests: Read and write*.
2. In `backend/.env`:

   ```env
   GITHUB_TOKEN=github_pat_...
   GITHUB_OWNER=your-org
   GITHUB_REPO=your-repo
   GITHUB_BASE_BRANCH=main
   GITHUB_ALLOWED_PATHS=services/,deploy/,terraform/modules/
   ```

   (`GITHUB_REPO_URL`/`GITHUB_REPO_REF` from the previous DebugAssist config are still understood.)

Safety rules:

- Only files under `GITHUB_ALLOWED_PATHS` are read and sent to the model, and only those can be
  changed. `docs/incidents/` is always allowed for the generated RCA file. `.github/`, `.env*`, keys,
  `*.tfstate` and lock files are always denied. With `GITHUB_ALLOWED_PATHS` empty, PRs contain only the RCA.
- The model can only make exact, unique search/replace edits to files it was shown.
- Validation is static: allowed path, non-empty, size limit, secret scan, and syntax (JSON, YAML,
  `bash -n`, bracket balance for Terraform). No model-generated command is ever executed; Terraform is never applied.
- PRs go to a new `nagent/inc-…` branch — never to the base branch — and require clicking
  **Approve & create PR** unless `AUTO_CREATE_PR=true` (local development only).
- Without GitHub configuration the patch preview (RCA document) is still shown, with no PR.

## GitLab

GitLab projects (gitlab.com or self-managed) work the same way, with a **merge request** instead of a PR.
Both can be configured at once; the *Report an incident* form then shows a **Repository** picker.

1. Create a **project access token** (Settings → Access tokens) with role *Developer* and scope `api`,
   or a personal access token with scope `api`. (`read_api` is enough for analysis only, not for MRs.)
2. In `backend/.env`:

   ```env
   GITLAB_TOKEN=glpat-...
   GITLAB_OWNER=your-group            # nested groups: your-group/subgroup
   GITLAB_REPO=your-project
   GITLAB_BASE_BRANCH=main
   GITLAB_ALLOWED_PATHS=services/,deploy/
   # GITLAB_URL=https://gitlab.example.com   # only for self-managed GitLab (default https://gitlab.com)
   ```

The same safety rules apply (`GITLAB_ALLOWED_PATHS`, deny list, new `nagent/…` branch, approval).
`*` in `GITHUB_ALLOWED_PATHS` / `GITLAB_ALLOWED_PATHS` allows the whole repository; the deny list still applies.
The MR is created with *delete source branch* set. When only one of GitHub/GitLab is configured it is
used automatically; when both are, alerts and Teams intake use GitHub unless the webhook URL has
`?repo=gitlab` (for example `POST /api/webhooks/alerts?repo=gitlab`).

## More repositories

Add any number of extra repositories by copying a GitHub or GitLab block and giving every setting the
same numeric suffix. Each one gets its own entry in the report form's **Repository** picker:

```env
GITHUB_TOKEN_2=github_pat_...
GITHUB_OWNER_2=another-org
GITHUB_REPO_2=another-repo
GITHUB_BASE_BRANCH_2=main
GITHUB_ALLOWED_PATHS_2=*

GITLAB_TOKEN_3=glpat-...          # GITLAB_URL_3 for self-managed GitLab
GITLAB_OWNER_3=group
GITLAB_REPO_3=project
```

Repository ids are `github`, `gitlab` (the unnumbered settings), `github-2`, `gitlab-3`, … — use them
in webhook URLs, e.g. `POST /api/webhooks/alerts?repo=github-2`. Alerts without `?repo=` go to the first
configured repository. Reusing an unnumbered name (a second `GITHUB_OWNER=`) does **not** add a repository;
the later line silently replaces the earlier one.

**Try the PR flow safely first:** `GITHUB_MOCK=true` uses an in-memory sample repository
(`services/payment-api/config.yaml`, `deploy/payment-api.yaml`); PR links look like
`mock://github/...` and are labeled as mock in the UI. The mock repository resets when the backend restarts.

## Alert webhook

`POST /api/webhooks/alerts` — requires `WEBHOOK_SIGNING_SECRET` (all webhook requests are rejected
until it is set). Authenticate with either an HMAC signature of the raw body or a bearer token:

```bash
SECRET=your-webhook-secret
BODY='{"alertname":"HighErrorRate","severity":"critical","description":"5xx above 10%","service":"payment-api","environment":"production","timestamp":"2026-10-13T10:00:00Z","logs":["ERROR POST /checkout 504"]}'

# HMAC-SHA256 (preferred)
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $NF}')"
curl -X POST http://127.0.0.1:8080/api/webhooks/alerts \
  -H 'Content-Type: application/json' -H "X-Nagent-Signature: $SIG" -d "$BODY"

# Bearer token (for tools that can't sign)
curl -X POST http://127.0.0.1:8080/api/webhooks/alerts \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $SECRET" -d "$BODY"
```

The response is `202` immediately; the investigation runs in the background. The body may also be
an array of alerts or a Prometheus Alertmanager payload (`{"alerts":[{"labels":{...},"annotations":{...}}]}`;
resolved alerts are ignored). Repeats of the same alert (service + environment + alertname) while
the incident is open increment its occurrence count instead of creating new incidents.
`POST /api/webhooks/teams` (`{ "title", "text" }`) remains available for Power Automate intake.

## Microsoft Teams (optional)

Set `TEAMS_WEBHOOK_URL` to a Power Automate / Teams Workflows HTTP trigger. Nagent POSTs JSON with
`event` (`incident_received`, `rca_ready`, `pr_created`, `investigation_failed`), `title`, a
ready-to-post markdown `text`, and fields such as `incidentId`, `severity`, `rootCause`, `prUrl`,
`error`. For every new incident the Teams message is sent **first**; the investigation starts only after it
was delivered. Unset → notifications are skipped; failures are logged on the timeline and never stop the workflow.

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | DB, Ollama, GitHub, GitLab, Teams status (no secrets) |
| GET | `/api/incidents` | List (summaries) |
| POST | `/api/incidents` | `{title, description?, severity, service?, environment?, logs?, repo?: "github" \| "gitlab" \| "github-2" …}` → 201; investigation starts automatically; 400 if `repo` is not configured |
| GET | `/api/incidents/:id` | Full incident: timeline, analysis, remediation |
| POST | `/api/incidents/:id/investigate` | `{mode: "ai" \| "demo"}` → 202; 409 if already running |
| GET | `/api/incidents/:id/rca` | Analysis + remediation; 404 until ready |
| POST | `/api/incidents/:id/approve` | Creates branch + commit + PR (GitLab: MR); 412 if the repository is not configured |
| POST | `/api/webhooks/alerts` | Authenticated alert intake → 202; optional `?repo=<repository id>` |

## Tests

```bash
npm --prefix backend test         # node:test — e2e + unit tests, all external services mocked
npm --prefix backend run typecheck
npm --prefix project run build    # frontend typecheck + production build
npm --prefix project run lint
```

The end-to-end test drives the HTTP API through create → investigate → RCA → proposed fix →
validation → approve → (mock) PR, plus Ollama-unavailable, demo mode, webhook auth/dedup and
validation cases. It uses a fake analyzer, the mock repository and a local fake Teams server.

## Known limitations

- **No user authentication.** The API binds to `127.0.0.1` by default; anyone who can reach it can
  approve PRs. Don't expose it on a network without adding auth.
- Validation is static only: the repository's own tests/CI are not run before the PR (CI on the PR
  is the real gate). Terraform files get a bracket check, not `terraform validate`.
- File selection is heuristic (paths/names mentioned in the report, service name), limited to 3
  files (first 6 KB of each) shown to the model. Fixes needing other files won't be proposed.
- Small local models make mistakes; confidence is the model's own estimate. Always review the diff.
- One process, background jobs in memory: a restart interrupts running investigations (they are
  marked failed and can be retried).
- `node:sqlite` prints an "experimental" warning on startup; this is expected.
- The previous clone-and-run agent (llama.cpp / Cursor) lives in `backend/legacy/` and is not used.
