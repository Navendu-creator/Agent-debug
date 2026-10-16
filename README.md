# Nagent

A small, local incident-investigation tool. An engineer reports an incident (web UI or alert
webhook); Nagent analyzes it with a **local Ollama model**, produces a root-cause analysis that
separates verified facts from hypotheses, proposes a minimal patch against your GitHub or GitLab
repository, validates it, and — **after you approve** — opens a pull (merge) request.

```
report (UI / webhook) ─► SQLite ─► read relevant repo files + their newest commits ─► Nagent static checks
   ─► Ollama analysis (JSON, schema-validated) ─► fact grounding ─► RCA
   ─► patch (exact search/replace on allowed paths; Nagent's own fix when the model's is wrong)
   ─► static validation ─► [Approve] ─► new branch nagent/inc-… ─► one commit ─► PR / MR
                                        Teams notifications at each step (optional)
```

New here? Read [Quick start](#quick-start-docker) to run it, then [Working on the code](#working-on-the-code).

| Part | Tech |
|---|---|
| `backend/` | Node.js 22, Express, TypeScript (tsx), zod, SQLite via built-in `node:sqlite` |
| `project/` | React 18, Vite, Tailwind |
| AI | Ollama (`/api/chat` with JSON-schema structured output) |
| GitHub | REST API (Git Data API for branch + commit, Pulls API for the PR) |

## Quick start (Docker)

Needs only Docker with Compose v2.24+. Nothing else is installed on the host.

```bash
git clone <this repository> && cd <it>
cp backend/.env.example backend/.env   # set GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO (or the GITLAB_* lines)
docker compose up -d --build           # first start downloads the model (~5 GB for qwen3:8b)
```

Open http://127.0.0.1:5173 and report an incident. Only the repository token, owner and repo are
required; everything else has a working default (the whole repository is readable unless you
restrict `*_ALLOWED_PATHS`, Teams and webhooks are off until configured). After editing `backend/.env`
run `docker compose up -d` again. See [Run with Docker](#run-with-docker) for details.

## Prerequisites (without Docker)

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

### The web UI

| Page | What it is for |
|---|---|
| Overview | Open incidents, trend chart, what needs attention |
| Incidents | All incidents; click one for its drawer: report, RCA (facts vs hypotheses), proposed diff, validation results, timeline, and the actions *Re-run investigation*, *Stop*, *Reject*, *Approve & create PR*, *Resolve*, *Reopen*, *Assign owner*, *Delete* |
| Services | Incidents grouped by service |
| Repositories | Configured GitHub/GitLab repositories, base branch and allowed paths |
| Approvals | Patches waiting for review |
| Audit log | Every action with who did it, kept even after an incident is deleted |
| Settings | Your name for the audit log (kept in this browser — there is no login), and the status of Ollama, repositories, Teams and webhooks (configuration itself lives in `backend/.env`) |

### Database

SQLite at `DATABASE_URL` (default `file:./data/opspilot.db`, relative to `backend/`). The schema is
created automatically on startup; to create it explicitly: `npm --prefix backend run db:init`.
Delete the file to reset. Investigations interrupted by a restart are marked failed and can be retried.

## Run with Docker

Needs only Docker with Compose v2.24+ (no Node.js or Ollama on the host). Runs three containers: `web`
(nginx serving the built UI and proxying `/api`), `backend`, and `ollama`.

```bash
cp backend/.env.example backend/.env   # fill in your repository; Teams / webhook settings are optional
docker compose up -d --build           # first start downloads OLLAMA_MODEL (~5 GB for qwen3:8b)
docker compose logs -f ollama-pull     # follow the model download
```

Open http://127.0.0.1:5173. Settings are read from `backend/.env` and/or a `.env` next to
`docker-compose.yml` (`backend/.env` wins when both set a value). After changing them, run
`docker compose up -d` — Compose recreates the containers whose settings changed. If the model has not
finished downloading when the first incident arrives, the backend downloads it itself (shown on the timeline).

`backend/.env` is shared with the non-Docker setup; inside Docker, `HOST`, `PORT`, `DATABASE_URL` and
`OLLAMA_BASE_URL` are overridden. The database lives in the `nagent-data` volume and the models in
the `ollama` volume, so `docker compose down` keeps both (`down -v` deletes them). For an NVIDIA GPU,
uncomment the `deploy:` block of the `ollama` service in `docker-compose.yml`.

Docker-only settings go in a `.env` file in the repository root:

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
(`qwen3:4b`, `llama3.2:3b`) are faster but less accurate. `AI_TIMEOUT_MS` (default 30 min per model call)
can be raised for slow machines; a timeout error says whether the model was still reading the prompt
(machine too slow: smaller model, more threads) or already answering (raise the timeout).
With Docker Desktop (macOS/Windows), Ollama only gets the CPUs and memory assigned in Settings → Resources.
`qwen3:8b` needs about 6–8 GB of free RAM. `OLLAMA_NUM_CTX` (default 8192) sets the context window;
raising it costs memory. If the OS kills Ollama for lack of RAM, the investigation fails with a clear error.
`OLLAMA_KEEP_ALIVE` (default `30m`) keeps the model loaded between analyses, so only the first one
after a restart pays the load time. `OLLAMA_NUM_THREAD` sets the CPU threads the model uses. Unset, Nagent uses all physical cores (Ollama's
own default on hybrid Intel laptop CPUs, e.g. i5-1235U with 2 P-cores + 8 E-cores, would be only 2 —
several times slower). The value in use is shown by `GET /api/health` (`ai.numThread`).

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
   *Pull requests: Read and write*. (*Contents: Read* also covers the commit history Nagent reads.)
2. In `backend/.env`:

   ```env
   GITHUB_TOKEN=github_pat_...
   GITHUB_OWNER=your-org
   GITHUB_REPO=your-repo
   GITHUB_BASE_BRANCH=main
   GITHUB_ALLOWED_PATHS=services/,deploy/,terraform/modules/   # optional; empty = whole repository
   ```

   (`GITHUB_REPO_URL`/`GITHUB_REPO_REF` from the previous DebugAssist config are still understood.)

Safety rules:

- Only files under `GITHUB_ALLOWED_PATHS` are read and sent to the model, and only those can be
  changed; unset or empty means the whole repository. `docs/incidents/` is always allowed for the
  generated RCA file. `.github/`, `.env*`, keys, `*.tfstate` and lock files are always denied. To allow
  only the RCA document, set `GITHUB_ALLOWED_PATHS=docs/incidents/`.
- The model can only make exact, unique search/replace edits to files it was shown. When none of its
  edits match the file (a common small-model slip), Nagent tells it why and asks once for a corrected edit.
- Validation is static: allowed path, non-empty, size limit, secret scan, syntax (JSON, YAML,
  `bash -n`, bracket balance for Terraform), and for Kubernetes manifests the API server's own rules
  (see [How Nagent finds the fix](#how-nagent-finds-the-fix)). A patch that fails any check cannot be
  approved. No model-generated command is ever executed; Terraform is never applied.
- PRs go to a new `nagent/inc-…` branch — never to the base branch — and require clicking
  **Approve & create PR** unless `AUTO_CREATE_PR=true` (local development only).
- Without GitHub configuration the patch preview (RCA document) is still shown, with no PR.

## How Nagent finds the fix

Small local models often get the root cause roughly right but the edit wrong, or patch a symptom
instead of the cause. So Nagent runs deterministic checks of its own, gives their results to the model
as verified findings, and uses its own fix when the model's patch does not apply or does not pass validation.

| Check | Catches | Nagent's own fix |
|---|---|---|
| Commit history | The newest 3 commits to each file read. The newest diff is shown to the model as `recent_changes` | When the error says a key is required (`containers: Required value`, kustomize `missing kind in object`) and a recent commit removed it: restore exactly the lines that commit removed (only that change, not the whole commit) |
| Kubernetes rules | Every object needs `kind` and `metadata.name`; workloads need `containers` with a name and image; probes are forbidden on init containers without `restartPolicy: Always`. Also detects a deleted `containers:` header that left the main container's settings under the init container | — (its errors drive the history fix and validation) |
| Terraform names | `module "" {` when the report names `module.vpc` | Name the block |
| Quoted code | The reporter pastes a line and says it is commented out | Uncomment that line |

Decision rules in `services/pipeline.ts`:

1. The model's patch applies and passes validation → it is used.
2. It applies but fails validation (for example `kind:` added but `metadata:` still missing), and a
   validated Nagent fix exists → Nagent's fix is used. The root cause then comes from Nagent's check, and
   the model's explanation is listed under hypotheses.
3. It does not apply → Nagent's fix if there is one, otherwise the model is asked **once** to correct the edit.
4. Still failing → the patch is shown as `validation_failed` and cannot be approved.

Every step is written to the incident timeline, so you can see which fix was used and why.

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
| POST | `/api/incidents/:id/cancel` | Stops a running investigation (aborts the Ollama request) |
| POST | `/api/incidents/:id/reject` | `{actor?, reason?}` declines the proposed patch |
| POST | `/api/incidents/:id/resolve` / `reopen` | Closes / re-opens the incident |
| PATCH | `/api/incidents/:id` | `{owner}` assigns an owner |
| DELETE | `/api/incidents/:id` | Deletes the incident (its history stays in the audit log) |
| GET | `/api/audit` | Audit log of all actions, newest first |
| POST | `/api/webhooks/alerts` | Authenticated alert intake → 202; optional `?repo=<repository id>` |
| POST | `/api/webhooks/teams` | Power Automate intake `{title, text}` |

Actions accept an optional `actor` (the UI sends the name set on the Settings page); it is recorded in the audit log.

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
`npm run check` in the repository root runs all of the above.

## Working on the code

```
backend/            Express API + investigation pipeline (TypeScript, run with tsx — no build step)
  src/index.ts        entrypoint
  src/app.ts          express app, /api/health
  src/config.ts       every setting read from backend/.env (incl. numbered repositories)
  src/db.ts           SQLite (node:sqlite): incidents + audit log
  src/routes/         incidents.ts (UI API + audit), webhooks.ts (alert / Teams intake)
  src/services/
    pipeline.ts       the workflow: gather files → checks → model → choose fix → validate → approve → PR
    ai.ts             Ollama client, prompt, output schema, fact grounding, demo analyzer
    patch.ts          file selection, static checks and fixes, history restore, applying edits, validation, RCA markdown
    k8s.ts            Kubernetes API validation rules
    repo.ts           GitHub / GitLab REST providers (files, history, PR/MR), mock repo, path deny list
    teams.ts          Teams notifications
  src/e2e.test.ts     HTTP-level tests of whole incidents (fake analyzer + MockRepo)
  src/services/unit.test.ts
  legacy/             old clone-based agent, unused
project/            React UI (Vite + Tailwind)
  src/App.tsx         page routing (hash based)
  src/pages/          Overview, Incidents, Services, Repositories, Approvals, AuditLog, Settings
  src/components/     incident table/drawer, diff view, report dialog, shared UI
  src/lib/api.ts      typed client for the backend API
docker-compose.yml  web (nginx) + backend + ollama + one-shot model pull
```

**Day-to-day loop:** `npm run dev` (backend reloads on save; the UI hot-reloads), with `GITHUB_MOCK=true`
in `backend/.env` if you do not want to touch a real repository. Before pushing run `npm run check`.

**Ground rules the code follows** — keep them when you change it:

- Model output is untrusted. It is schema-validated, its facts must quote the input verbatim, and its
  edits are exact search/replace on files it was shown. Never execute anything the model produced.
- Never fake a result: if Ollama or the repository is unavailable, the investigation fails with a clear
  error. Demo output is always labeled.
- Nothing is written to a repository without approval, and only to a new `nagent/…` branch.
- Every decision goes on the incident timeline (`addEvent`), so a reviewer can see why.

**Adding a deterministic check or fix** (the most common change): write a pure function in
`services/patch.ts` (or a new module like `k8s.ts`) that takes file contents and returns findings or a
`ProposedChange`; call it from `gatherFiles` in `services/pipeline.ts`, which feeds findings to the model
and offers fixes through `staticFixes`. If it is a rule a patch must satisfy, add it to `validateChanges`.
Add a unit test, and an e2e test in `src/e2e.test.ts` that replays a real incident: give `MockRepo` the
broken files (and `repo.history` for commits), and `setAnalyzer` the model's wrong answer.

**Debugging an incident:** the timeline shows which files were read, static findings, which fix was used
and why. To reproduce one without waiting minutes for the model, copy the report into an e2e test as above.

**Contributing:** branch off `main`, keep commits focused, run `npm run check`, and open a PR.

## Known limitations

- **No user authentication.** The API binds to `127.0.0.1` by default; anyone who can reach it can
  approve PRs. Don't expose it on a network without adding auth.
- Validation is static only: the repository's own tests/CI are not run before the PR (CI on the PR
  is the real gate). Terraform files get a bracket check, not `terraform validate`.
- File selection is heuristic (code quoted in the report, paths/names mentioned, service name, keyword
  search), limited to 3 files (first 6 KB of each) shown to the model. Fixes needing other files won't
  be proposed. Pasting the offending line or naming the file gives the best results.
- The history restore looks at the newest 3 commits per file, and the Kubernetes rules cover the common
  API errors above, not the full schema (`kubectl apply --dry-run=server` is not run).
- Small local models make mistakes; confidence is the model's own estimate. Always review the diff.
- One process, background jobs in memory: a restart interrupts running investigations (they are
  marked failed and can be retried).
- `node:sqlite` prints an "experimental" warning on startup; this is expected.
- The previous clone-and-run agent (llama.cpp / Cursor) lives in `backend/legacy/` and is not used.
