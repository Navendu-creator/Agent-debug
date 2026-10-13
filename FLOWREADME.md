# Nagent — Incident-to-PR Automation

_As of 2026-10-13_

## Executive summary

Nagent turns an incident report into a reviewed GitHub pull request. It posts the incident to Teams, analyzes it with a local AI model, proposes a minimal Terraform fix, validates it, and opens a PR only after an engineer approves.

- **Status:** working MVP running on a developer laptop, connected to `Navendu-creator/infra-setup`. It has opened real PRs (for example PR #7) and posts to the `debug-agent` Teams channel.
- **Cost:** $0 per incident. The model (Qwen3 8B) runs locally through Ollama; no paid AI API or cloud service is used.
- **Control:** nothing reaches the repository without a human click on "Approve & create PR", and changes are limited to an allow-list of Terraform paths.
- **The ask:** agreement to run a 2–4 week pilot on a shared machine, and a decision on the hosting and access questions in the last section.

## How it works

An incident becomes a pull request in eight steps. The only step that writes to GitHub runs after an engineer approves.

```
 Nagent pipeline                                        Teams channel
 ┌──────────────────────────────────────────────┐
 │ 1. Incident reported                         │
 │    Web form or signed alert webhook;         │
 │    the request returns at once               │
 └──────────────────────┬───────────────────────┘
                        ▼
 ┌──────────────────────────────────────────────┐        ┌──────────────────────┐
 │ 2. Saved and announced                       │ ─ ─ ─▶ │ New incident         │
 │    Stored in SQLite; Teams card posted       │        │ Adaptive Card        │
 │    before work starts                        │        └──────────────────────┘
 └──────────────────────┬───────────────────────┘
                        ▼
 ┌──────────────────────────────────────────────┐
 │ 3. Relevant code read                        │
 │    Up to 3 allow-listed Terraform files      │
 │    fetched from GitHub                       │
 └──────────────────────┬───────────────────────┘
                        ▼
 ┌──────────────────────────────────────────────┐        ┌──────────────────────┐
 │ 4. AI analysis on local Ollama               │ ─ ─ ─▶ │ RCA ready            │
 │    Schema-checked JSON: root cause,          │        │ Root cause + conf.   │
 │    evidence, proposed edits                  │        └──────────────────────┘
 └──────────────────────┬───────────────────────┘  on failure ┌──────────────────────┐
                        │                          ─ ─ ─ ─ ─▶ │ Investigation failed │
                        ▼                                     │ Clear error, no fake │
 ┌──────────────────────────────────────────────┐             └──────────────────────┘
 │ 5. Grounding and patch                       │
 │    Facts need verbatim quotes; edits must    │
 │    match the file exactly                    │
 └──────────────────────┬───────────────────────┘
                        ▼
 ┌──────────────────────────────────────────────┐
 │ 6. Static validation                         │
 │    Allowed path, syntax, secret scan,        │
 │    change size                               │
 └──────────────────────┬───────────────────────┘
                        ▼
 ╔══════════════════════════════════════════════╗
 ║ 7. Engineer reviews and approves  (HUMAN GATE)║ ─ ─ ▶  Not approved: nothing is written
 ║    RCA, diff and check results in dashboard  ║
 ╚══════════════════════╤═══════════════════════╝
                        ▼ approved
 ┌──────────────────────────────────────────────┐        ┌──────────────────────┐
 │ 8. Branch, commit and pull request           │ ─ ─ ─▶ │ PR created           │
 │    New nagent/* branch; PR against main    │        │ Card with Open PR    │
 └──────────────────────────────────────────────┘        └──────────────────────┘
```

A typical run takes 3–8 minutes on the current laptop, almost all of it in step 4. Teams receives a card at each milestone, and the incident's full timeline is kept in the dashboard.

## Architecture and cost

Nagent is two small Node.js apps and a local model server. Every component is open source and runs on one machine.

| Component | Technology | Role |
| --- | --- | --- |
| Dashboard | React 18, Vite, Tailwind | Report incidents, review RCA and diff, approve PRs |
| API | Node.js 22, Express, TypeScript, zod | Intake, webhook auth, investigation pipeline, PR creation |
| Storage | SQLite (built into Node.js) | Incidents, timelines, analyses, patches; survives restarts |
| AI | Ollama with Qwen3 8B | Structured JSON root-cause analysis and proposed edits |
| GitHub | REST API with a fine-grained token | Read allowed files; create branch, commit and PR |
| Notifications | Teams Workflows webhook (Adaptive Cards) | Incident received, RCA ready, PR created, failed |

Running cost is the machine itself. On the current laptop (CPU only, 15 GB RAM) one analysis takes 3–8 minutes; a GPU or a larger server would cut this substantially.

## Safety and guardrails

The AI proposes; deterministic code checks and a human decide. Each guardrail below is enforced in code and covered by automated tests.

| Guardrail | What it prevents |
| --- | --- |
| Human approval before any PR | Unreviewed changes reaching the repository (auto-PR exists only as an opt-in dev setting) |
| New `nagent/inc-*` branch per PR, never the base branch | Direct pushes to `main` |
| Path allow-list (`terraform/aws/environments/dev`, `terraform/aws/modules`) | Edits anywhere else |
| Always-denied paths: `.github/`, `.env`, keys, `*.tfstate`, lock files | CI tampering, secret or state changes |
| Exact search-and-replace edits, only on files the model was shown | Invented files or edits to text that does not exist |
| Fact grounding: a "fact" needs a verbatim quote, labeled as from the report or from the repository | Presenting guesses or invented log lines as evidence |
| Static validation: syntax, secret scan, change size, allowed path | Broken or leaking patches |
| No execution of AI-generated commands; Terraform is never applied | Infrastructure changes outside review |
| Webhook HMAC or bearer secret; API bound to localhost | Unauthenticated alert injection |
| Secrets only in server-side `.env`; never in API responses or the UI bundle | Credential leaks |

If the model is unavailable, the investigation fails with a clear error instead of producing a fake result.

## Validation so far

15 automated tests pass, and live runs against `infra-setup` produced correct fixes or correctly declined to change code.

**Automated tests** (Node test runner, all external services mocked): an end-to-end run from incident to PR, Ollama unavailable, demo mode, webhook authentication and deduplication, input validation, path policy, secret scan, GitHub API sequence, Teams card format, and the "claimed typo not in code" case.

**Live runs** (real Ollama, real repository, real Teams channel):

| Incident | Outcome |
| --- | --- |
| "Increase a replica" | Found `deployment.replicas = "1"` in `terraform/aws/modules/traefik/main.tf`; proposed `"2"`; all checks passed |
| "dev-postgres is named dev-postgresss" | Repository already says `dev-postgres`; edit rejected as "already applied"; RCA points to drift between Terraform and AWS; PR #7 contained only the RCA |
| Payment API timeouts (sample repo) | Traced to a DB pool of 5 connections from quoted log lines; proposed a pool size of 10 |
| Payment API OOMKilled (sample repo) | Traced to a 128Mi memory limit; proposed 256Mi |

Issues found during live testing and fixed: requests over 5 minutes timing out, real log lines wrongly marked unverified, Teams messages not rendering, and a read-only GitHub token (a configuration error, now detected with a clear message).

## Limitations and risks

The main gaps are access control, validation depth and model accuracy; none blocks a supervised pilot.

| Limitation | Impact | Mitigation |
| --- | --- | --- |
| No user login; approval is one click | Anyone who reaches the API could approve a PR | API listens on localhost only; add SSO before shared hosting |
| Validation is static; `terraform validate` and `plan` are not run | A syntactically valid but wrong change can reach a PR | CI on the PR remains the merge gate; add a sandboxed `plan` check |
| Small local model can misread a report | Wrong root cause or a weak fix | Grounding, rejected-edit detection, confidence capped at 30% when the code disagrees, human review |
| Reads at most 3 files of 6 KB each | Fixes spanning many files are not proposed | Name the module or file in the report; larger model and context on better hardware |
| 3–8 minutes per analysis on CPU; one investigation at a time in practice | Slow during multi-incident outages | GPU host or a larger Ollama server |
| Single process, in-process job queue | A restart interrupts running investigations | They are marked failed and can be retried from the UI |

## Next steps and decisions

Recommendation: run a supervised pilot on the dev environment, then decide on hosting based on the results.

**Decisions needed**

- Pilot scope: dev Terraform only (current allow-list), or also staging?
- Hosting: keep on a developer machine, or move to a shared internal server with a GPU?
- Access: who may approve PRs, and which SSO to put in front of the dashboard?
- Alert sources: which monitoring tools should send alerts to the webhook?

**Proposed work**

- [ ] Pilot on dev for 2–4 weeks; track PR acceptance rate and time saved per incident
- [ ] Add login and per-user approval records before shared hosting
- [ ] Run `terraform fmt` and `validate` in a sandbox before opening a PR
- [ ] Connect production alerting (Alertmanager or Grafana) to the webhook
- [ ] Evaluate a larger model on GPU hardware for accuracy and speed
