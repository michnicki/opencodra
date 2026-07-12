<!-- refreshed: 2026-07-12 -->
# Architecture

**Analysis Date:** 2026-07-12

## System Overview

```text
┌─────────────────────────────────────────────────────────────────────┐
│                     Cloudflare Worker (single script)                │
│                        `src/server/index.ts`                         │
├──────────────────────────┬────────────────────────────────────────────┤
│  fetch(request, env, ctx) │  queue(batch, env, ctx)   │ scheduled(...) │
│  → Hono app                │  → creates Workflow       │ → maintenance  │
│  `src/server/app.ts`       │    instances from          │   sweep only  │
│                             │    validated messages      │  (KV-gated)   │
└──────────────┬─────────────┴──────────────┬──────────────┴──────┬──────┘
               │                            │                     │
               ▼                            ▼                     │
   ┌───────────────────────┐   ┌───────────────────────────────┐  │
   │  Webhook / OAuth / API │   │   ReviewWorkflow (Durable)     │  │
   │ `routes/*`, `routes/api/*` │  `src/server/workflows/review.ts` │ │
   └───────────┬────────────┘   │  step.do() loop: prepare →     │  │
               │                │  review (chunked) → finalize   │  │
               ▼                │  `core/review.ts::runReviewJob` │  │
   ┌───────────────────────┐    └───────────────┬────────────────┘  │
   │   Services layer       │                    │                   │
   │ `services/github.ts`   │◄───────────────────┘                   │
   │ `services/model.ts`    │                                        │
   │ `services/formatter.ts`│                                        │
   └───────────┬────────────┘                                        │
               │                                                     │
               ▼                                                     │
   ┌───────────────────────┐   ┌────────────────────────────────┐    │
   │  Model provider adapters│  │      Database layer            │◄───┘
   │ `models/openai.ts` etc. │  │  `db/*.ts` (raw SQL, postgres.js)│
   └───────────┬─────────────┘  │  request-scoped via AsyncLocalStorage │
               │                │  `db/client.ts::runWithDb`      │
               ▼                └──────────────┬──────────────────┘
   ┌───────────────────────┐                    │
   │  External LLM APIs     │                    ▼
   │ (OpenAI/Anthropic/     │        ┌─────────────────────────┐
   │  Google/Workers AI)    │        │  External Postgres        │
   └───────────────────────┘        │  (via Hyperdrive binding)  │
                                     └─────────────────────────┘
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| Worker entry | Wraps `fetch`/`queue`/`scheduled` in `runWithDb`; queue handler validates messages and starts Workflow instances | `src/server/index.ts` |
| Hono app | Wires routers, auth/CSRF middleware, SPA fallthrough | `src/server/app.ts` |
| ReviewWorkflow | Cloudflare Workflows durable execution: drives phase state machine, sleeps to reset subrequest budgets, spawns fresh instances | `src/server/workflows/review.ts` |
| Review core | Phase logic (prepare/review/finalize), lease/heartbeat, chunking, retry classification | `src/server/core/review.ts` |
| Diff engine | Parses unified diffs, filters reviewable files/hunks | `src/server/core/diff.ts` |
| Model service | Resolves model chains/fallbacks/size overrides, dispatches to provider adapter | `src/server/services/model.ts` |
| Model adapters | Provider-specific request/response mapping | `src/server/models/openai.ts`, `anthropic.ts`, `google.ts`, `cloudflare.ts` |
| Model output validation | Parses/repairs LLM JSON output against Zod schema | `src/server/core/model-output.ts` |
| GitHub client/service | Octokit-style REST calls, comment/check-run posting, diff fetch | `src/server/core/github.ts`, `src/server/services/github.ts` |
| Formatter | Renders findings into GitHub-flavored markdown comments | `src/server/services/formatter.ts` |
| DB layer | One module per table/domain, raw SQL via `postgres.js` | `src/server/db/*.ts` |
| DB client/context | AsyncLocalStorage-scoped connection, `getDb`/`queryRows`/`queryTransaction` | `src/server/db/client.ts` |
| Shared schema | Zod contracts for queue messages, config, API, model output | `src/shared/schema.ts` |
| Client SPA | React 19 dashboard consuming `/api/*` | `src/client/` |

## Pattern Overview

**Overall:** Single-Worker, multi-entry-point serverless architecture. HTTP and background-job concerns share one deployed script and one codebase, distinguished by exported handler (`fetch`/`queue`/`scheduled`) and by Cloudflare Workflows for the long-running review job itself.

**Key Characteristics:**
- Durable-execution state machine (Cloudflare Workflows) rather than a simple queue-consumer loop: `core/review.ts::runReviewJob` returns an action (`ack` | `retry` | `next_phase`) that `workflows/review.ts` interprets to decide `step.do`/`step.sleep`/re-enqueue.
- Request/invocation-scoped DB connection via `AsyncLocalStorage` (`runWithDb`) — no client threading, no connection-per-call leakage across Workers isolate boundaries.
- Contract-first: all wire/queue/DB-JSON shapes defined once in `src/shared/schema.ts` (Zod) and imported by both server and client.
- Idempotent, resumable phases: per-file review results persisted (`db/file-reviews.ts`) so a re-run of the `review` phase skips already-reviewed files.
- Explicit resource budget management: code is heavily annotated with Cloudflare Workers subrequest-limit (50/invocation) workarounds — chunk sizing, forced yields, "fresh instance" handoffs.
- Provider abstraction: `ModelService` treats all LLM providers uniformly through a shared `models/types.ts` interface, with a catalog (`models/catalog.ts`) for available models/limits.

## Layers

**HTTP/Routing layer:**
- Purpose: webhook ingestion, OAuth, dashboard REST API, SPA serving
- Location: `src/server/app.ts`, `src/server/routes/`, `src/server/routes/api/`
- Contains: Hono route handlers, request validation, session/CSRF guards
- Depends on: middleware (`src/server/middleware/`), core services, db layer
- Used by: Worker `fetch` handler

**Middleware:**
- Purpose: cross-cutting request concerns
- Location: `src/server/middleware/auth.ts` (session), `csrf.ts`, `observability.ts` (request id/logging)
- Depends on: `db/client.ts`, KV sessions
- Used by: `app.ts` route groups

**Workflow/orchestration layer:**
- Purpose: durable, resumable execution of the review job across phases and Worker invocations
- Location: `src/server/workflows/review.ts`
- Depends on: `core/review.ts`, `core/job-recovery.ts`, `db/jobs.ts`
- Used by: `index.ts` queue handler (creates instances), Cloudflare Workflows runtime (drives `run`)

**Core business logic:**
- Purpose: review job phases, GitHub webhook parsing, diffing, model-output validation, telemetry, crypto for stored LLM keys
- Location: `src/server/core/*.ts`
- Depends on: `services/*`, `models/*`, `db/*`, `shared/*`
- Used by: workflow layer, HTTP routes (webhook verification, OAuth)

**Services layer:**
- Purpose: encapsulate a single external concern behind one class (`GitHubService`, `ModelService`, `FormatterService`)
- Location: `src/server/services/*.ts`
- Depends on: `models/*`, `core/github.ts`, `db/model-configs.ts`
- Used by: `core/review.ts`

**Model provider adapters:**
- Purpose: translate the shared model-call interface to each provider's API shape
- Location: `src/server/models/*.ts`
- Depends on: provider SDKs/fetch, `models/types.ts`, `models/limits.ts`
- Used by: `services/model.ts`

**Database layer:**
- Purpose: raw SQL access, one module per table/domain, migrations tracked separately
- Location: `src/server/db/*.ts`, migrations in `db/migrations/*.sql`
- Depends on: `postgres` npm package, `db/client.ts` context
- Used by: nearly every other layer

**Shared contract layer:**
- Purpose: single source of truth for data shapes crossing worker/client/queue/DB-JSON boundaries
- Location: `src/shared/*.ts` (`schema.ts`, `api.ts`, `config.ts`, `github.ts`, `transient-errors.ts`)
- Depends on: Zod
- Used by: server and client both (import via `@shared`)

**Client SPA:**
- Purpose: dashboard UI for repo/model config, job history, DLQ/stats
- Location: `src/client/`
- Depends on: `@shared` schemas, `lib/api.ts` fetch wrapper
- Used by: served as static assets by the same Worker (`run_worker_first`), gated by session middleware for authenticated routes

## Data Flow

### Primary Request Path (PR review trigger)

1. GitHub sends a `pull_request` or `issue_comment` webhook to `POST /webhook` (`src/server/routes/webhook.ts`), verified via HMAC signature (`src/server/core/verify.ts`).
2. Webhook handler parses/validates payload against `@shared/github` types, persists delivery record (`db/webhook-deliveries.ts`), and enqueues a `ReviewJobMessage` onto `REVIEW_QUEUE` (validated by `reviewJobMessageSchema` in `src/shared/schema.ts`).
3. Worker `queue` handler (`src/server/index.ts`) validates the message again and calls `env.REVIEW_WORKFLOW.create({ id, params })`, starting a `ReviewWorkflow` instance (`src/server/workflows/review.ts`).
4. `ReviewWorkflow.execute` loops phases (`prepare` → `review` → `finalize`) via `step.do`, each phase delegating to `runReviewJob` (`src/server/core/review.ts`), which:
   - `prepare`: fetches PR diff via `GitHubClient`/`GitHubService`, parses it (`core/diff.ts`), persists job/file state (`db/jobs.ts`, `db/file-reviews.ts`).
   - `review`: chunks files by concurrency/subrequest budget, calls `ModelService` per file, validates/repairs model JSON (`core/model-output.ts`), persists per-file findings.
   - `finalize`: formats findings (`services/formatter.ts`), posts GitHub check run/comments, records telemetry (`core/telemetry.ts`).
5. Phase transitions communicate back to the workflow loop via `ReviewJobRunResult` (`ack` / `retry` / `next_phase`), which decides `step.sleep` delays or re-enqueues a fresh workflow instance when the subrequest budget is exhausted.

### Dashboard API Flow

1. React client (`src/client/`) calls `/api/*` endpoints via `src/client/lib/api.ts`.
2. `app.ts` applies `requireSession` + `requireCsrfHeader` middleware to all `/api/*` routes.
3. Route handlers in `src/server/routes/api/*.ts` call `db/*.ts` modules directly (no separate service layer for CRUD reads).
4. Responses are Zod-validated shapes from `src/shared/api.ts`/`schema.ts`, consumed by client hooks (`src/client/hooks/use-polling.ts` for live job status).

**State Management:**
- Server: job state machine persisted in Postgres (`db/jobs.ts`), lease + heartbeat fields prevent duplicate processing; KV (`APP_KV`) used only for session tokens and a lightweight `system:active_jobs` flag gating the `scheduled` cron.
- Client: React state/hooks per page; no global store — data fetched per page via `lib/api.ts` and polled via `use-polling.ts`.

## Key Abstractions

**ReviewJobMessage (Zod schema):**
- Purpose: the single message/parameter shape flowing from webhook → queue → Workflow instance → phase execution
- Examples: `src/shared/schema.ts`
- Pattern: one schema reused end-to-end; `forceFreshInstance`/`phase`/`jobId`/`deliveryId` fields drive resumability

**ReviewJobRunResult (discriminated union):**
- Purpose: decouples phase execution (`core/review.ts`) from workflow control flow (`workflows/review.ts`)
- Examples: `src/server/core/review.ts` (type `ReviewJobRunResult`)
- Pattern: action-returning function instead of throwing/side-effecting control flow

**DbClient / runWithDb (AsyncLocalStorage context):**
- Purpose: request/invocation-scoped Postgres client without threading a client parameter through every function
- Examples: `src/server/db/client.ts`
- Pattern: ambient context object, accessed via `getDb`/`queryRows`/`queryTransaction`

**Model provider interface:**
- Purpose: uniform contract so `ModelService` can route/fallback across providers without per-provider branching in caller code
- Examples: `src/server/models/types.ts`, implementations in `models/openai.ts`, `anthropic.ts`, `google.ts`, `cloudflare.ts`
- Pattern: strategy pattern, provider selected by catalog + repo/model config

**RetryableModelError:**
- Purpose: classifies transient provider failures so the workflow retries with backoff instead of failing the job
- Examples: `src/server/services/model.ts` (`isRetryableModelError`), consumed in `core/review.ts`
- Pattern: typed error class inspected by caller, not just generic try/catch

## Entry Points

**HTTP fetch:**
- Location: `src/server/index.ts` (`fetch`), routed through `src/server/app.ts`
- Triggers: any inbound HTTP request (webhooks, OAuth, dashboard API, SPA)
- Responsibilities: wrap in `runWithDb`, delegate to Hono app

**Queue consumer:**
- Location: `src/server/index.ts` (`queue`)
- Triggers: messages on `codra-review-jobs` queue (batch size 1, concurrency 1)
- Responsibilities: validate message schema, run pre/post maintenance, create/resume `ReviewWorkflow` instances, handle `instance.already_exists` dedup and DLQ-bound failures after 3 attempts

**Scheduled (cron):**
- Location: `src/server/index.ts` (`scheduled`)
- Triggers: Cloudflare cron trigger, fires every 2 minutes
- Responsibilities: KV-gated best-effort job maintenance (`core/job-recovery.ts`) — recovers stuck jobs, reconciles check runs — skipped entirely when no jobs are active to avoid waking the DB

**ReviewWorkflow.run:**
- Location: `src/server/workflows/review.ts`
- Triggers: created by the queue handler; Cloudflare Workflows runtime resumes it across `step.sleep`/hibernation
- Responsibilities: durable phase loop, subrequest-budget-aware yielding, fresh-instance handoff

## Architectural Constraints

- **Threading:** Single-threaded-per-invocation Workers isolate model; concurrency across files within a review phase is achieved via `Promise.all`-style chunking bounded by `budgetAwareChunkFileLimit`, not real parallelism.
- **Global state:** `dbStorage` (`AsyncLocalStorage`) and `fallbackClients` (`Map`, module-level) in `src/server/db/client.ts` are the only module-level shared state; the fallback map exists solely for test/non-`runWithDb` callers to avoid leaking a connection pool per query.
- **Cloudflare subrequest limit (50/invocation):** Pervasive constraint driving chunk sizing (`ESTIMATED_SUBREQUESTS_PER_FILE`), forced `step.sleep` yields (`FRESH_INVOCATION_YIELD_SECONDS`), and "fresh instance" re-enqueue logic in `src/server/core/review.ts` and `src/server/workflows/review.ts`.
- **No I/O across request contexts:** Cloudflare Workers forbids reusing a connection/promise created in one request in another; enforced by scoping the DB client to `runWithDb` per `fetch`/`queue`/`scheduled`/workflow invocation.
- **Circular imports:** None observed between `core/`, `services/`, `models/`, `db/` — dependency direction is routes → core → services → models/db, and `db/` modules do not import `core/` or `services/`.

## Anti-Patterns

### Long-lived Workflow instance budget exhaustion (mitigated, not eliminated)

**What happens:** A Cloudflare Workflow instance that stays "warm" across many short `step.sleep`s never fully hibernates, so its per-invocation subrequest budget (50) never resets and every subsequent step starts hitting the cap.
**Why it's wrong:** Without mitigation, large PRs (many files) would stall mid-review and finalize would never get the ~20 subrequests it needs to post the review.
**Do this instead:** `runReviewJob` signals `freshInstance: true` when it detects budget pressure or is entering `finalize`; `workflows/review.ts` then re-enqueues the next phase as a brand-new instance (`env.REVIEW_QUEUE.send({ forceFreshInstance: true, ... })`) instead of continuing in place. See comments in `src/server/core/review.ts` lines ~67-114 and `src/server/workflows/review.ts` lines ~84-107.

### Direct DB access from route handlers for reads

**What happens:** Several `routes/api/*.ts` handlers call `db/*.ts` query functions directly rather than going through a services layer.
**Why it's wrong:** Not itself a bug, but it means there is no consistent service boundary for dashboard reads — business logic for reads lives partly in routes, partly in `db/` modules. New complex read logic should be added to the `db/` module, not the route handler, to keep this consistent.
**Do this instead:** Keep query composition inside `db/*.ts`; route handlers should stay thin (parse request → call db function → shape response with `@shared/api` types).

## Error Handling

**Strategy:** Layered classification — GitHub/model transient errors are distinguished from hard failures so the workflow can retry with backoff instead of failing the whole job.

**Patterns:**
- `RetryableModelError` (`src/server/services/model.ts`) and `isTimeoutMessage`/`matchesAnyTransientSubstring` (`src/shared/transient-errors.ts`) classify provider errors as retryable; `runReviewJob` translates these into `{ action: 'retry', delaySeconds }`.
- Malformed queue messages are schema-validated (`reviewJobMessageSchema.safeParse`) and dropped with a matching job failure rather than retried indefinitely (`src/server/index.ts`).
- Maintenance tasks (`core/job-recovery.ts`) are wrapped in try/catch and treated as best-effort — a maintenance failure never fails the review job itself.
- `instance.already_exists` from `REVIEW_WORKFLOW.create` is treated as a benign duplicate-message signal, not an error.

## Cross-Cutting Concerns

**Logging:** Centralized `logger` (`src/server/core/logger.ts`), structured calls with context objects; `middleware/observability.ts` attaches a request id (`AppVariables.requestId`) for correlation.
**Validation:** Zod schemas in `src/shared/schema.ts`/`api.ts`/`github.ts` validate all external input (webhook payloads, queue messages, model output) and API request/response bodies.
**Authentication:** GitHub OAuth (`core/github-oauth.ts`, `core/oauth.ts`) issues KV-backed sessions (`core/sessions.ts`); `middleware/auth.ts::requireSession` guards `/api/*` and authenticated SPA routes; `middleware/csrf.ts::requireCsrfHeader` guards state-changing requests.

---

*Architecture analysis: 2026-07-12*
