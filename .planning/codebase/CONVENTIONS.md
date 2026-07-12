# Coding Conventions

**Analysis Date:** 2026-07-12

## Naming Patterns

**Files:**
- kebab-case for all source files: `model-config-cache.ts`, `file-reviews.ts`, `llm-crypto.ts`, `review-flow.spec.ts`
- One module per concern under `src/server/db/` — filename matches the table/domain it wraps (`jobs.ts`, `repositories.ts`, `webhook-deliveries.ts`)
- React components use kebab-case filenames but PascalCase exported component names: `src/client/components/ui/dropdown-menu.tsx` exports `DropdownMenu`

**Functions:**
- camelCase, verb-first: `getResolvedModelConfig`, `claimJobLease`, `parseUnifiedDiff`, `filterReviewableFiles`
- DB accessor naming convention: `get*` (read one), `list*`/`get*ForJobs` (read many), `insert*`, `update*`, `mark*` (status transition), `bulk*` (batch operation) — e.g. `bulkMarkFilesFailed`, `markJobCheckRunCompleted`

**Variables:**
- camelCase throughout; SCREAMING_SNAKE_CASE for module-level constants, always with an explanatory comment when the value encodes a tuned/empirical constraint (see `src/server/core/review.ts`: `MAX_JOB_CONTINUATIONS`, `ESTIMATED_SUBREQUESTS_PER_FILE`, `FRESH_INVOCATION_YIELD_SECONDS`)

**Types:**
- PascalCase for types/interfaces: `JobRow`, `ReviewJobRunResult`, `PersistedReviewJob`
- Zod-inferred types preferred over hand-written interfaces for anything crossing the worker/dashboard boundary (`src/shared/schema.ts`)
- Discriminated unions for control-flow results, e.g. `ReviewJobRunResult` in `src/server/core/review.ts`:
  ```typescript
  export type ReviewJobRunResult =
    | { action: 'ack' }
    | { action: 'retry'; delaySeconds: number }
    | { action: 'next_phase'; phase: 'prepare' | 'review' | 'finalize'; delaySeconds: number; jobId?: string; freshInstance?: boolean };
  ```

## Code Style

**Formatting:**
- No Prettier/Biome config present in the repo — formatting is not automatically enforced; match surrounding code style manually (2-space indent, single quotes, semicolons, trailing commas in multiline literals)

**Linting:**
- No ESLint config file present (`eslint.config.*` / `.eslintrc*` not found). Type safety is enforced primarily via `tsc --noEmit` (`npm run typecheck`) with `strict: true` in `tsconfig.json`. There is no auto-lint step in `npm test`; rely on TypeScript strictness and code review.

## Import Organization

**Order (observed, not enforced by tooling):**
1. External packages (`zod`, `postgres`, `node:async_hooks`)
2. `@shared/*` types and schemas
3. `@server/*` modules (env, db, services, core)
4. Relative imports (`./logger`, `../services/github`)

**Path Aliases (`tsconfig.json` / `vite.config.ts` / `vitest.config.ts`):**
- `@server/*` → `src/server/*`
- `@client/*` and `@/*` → `src/client/*`
- `@shared/*` → `src/shared/*`
- Always use aliases for cross-directory imports; never use deep relative paths like `../../../shared/schema`

## Error Handling

**Custom error classes**, all extending `Error`, used to carry structured retry/classification info rather than generic throws:
- `RetryableModelError` (`src/server/services/model.ts`) — model call failed transiently; carries `delaySeconds` guidance
- `ProviderRequestError`, `UnparseableModelResponseError` (`src/server/models/types.ts`) — provider-adapter-level failures
- `GitHubError` (`src/server/core/github.ts`) — GitHub API failures
- `TimeoutError` (`src/server/core/timeout.ts`)
- `NextPhaseError` (`src/server/core/review.ts`) — internal control-flow signal to force a phase transition

**Pattern:** Business logic returns typed result objects (e.g. `ReviewJobRunResult`) instead of throwing across phase boundaries in the queue consumer. Throwing is reserved for truly exceptional/unrecoverable conditions; expected failure modes (transient provider errors, retryable file failures) are modeled explicitly and classified with helper predicates (`isRetryableModelError`, `isTimeoutMessage`, `matchesAnyTransientSubstring`).

**Retry/backoff constants are always given a units suffix and a comment explaining the empirical reasoning** — follow this when adding new tunables (see `RETRYABLE_MODEL_FAILURE_RETRY_DELAYS_SECONDS` in `src/server/core/review.ts`).

**Client-side (`src/client/lib/api.ts`):** the shared `request<T>()` helper centralizes fetch behavior — sets JSON content-type, adds `x-requested-with` for unsafe methods, and redirects to `/login` + throws on 401. New API calls should go through this helper rather than calling `fetch` directly.

## Logging

**Framework:** Custom structured JSON logger, `src/server/core/logger.ts` (`Logger` class, singleton export `logger`).

**Patterns:**
- Always logs structured JSON: `{ timestamp, level, message, ...contextStore, ...data }`
- Per-request/job context is threaded via `AsyncLocalStorage` (`runWithContext`) rather than passed as a parameter through every function call — mirrors the `runWithDb` pattern used for the DB client
- Automatically redacts sensitive keys (`api_key`, `secret`, `password`, `token`, `authorization`, `cookie`, etc.) and any string that looks like a Bearer token or JWT (`redact()` in `logger.ts`) — **never log raw secrets or bypass this redaction**
- Use `logger.withContext({...})` to derive a scoped child logger instead of building ad-hoc message prefixes
- `logger.error(message, error)` accepts an `Error` instance directly and extracts `name`/`message`/`stack` automatically — pass the Error object, not `error.message` alone

## Comments

**When to Comment:**
- Extensive comments on any magic number, timeout, or concurrency constant explaining *why* the value was chosen and what regression it prevents (see `src/server/core/review.ts` — nearly every constant has a multi-line rationale comment). Follow this convention for any new tuning constant.
- Comments on discriminated union fields explain when/why each variant is produced, not just what it is.

**JSDoc/TSDoc:**
- Used selectively on exported functions with non-obvious behavior (e.g. `installGitHubFetchMock` in `test/github-fetch-mock.ts` has a `/** ... */` block explaining what it stubs and why). Not required on every function — reserved for behavior that isn't obvious from the signature.

## Function Design

**Size:** Core orchestration functions (e.g. in `src/server/core/review.ts`) are long and stateful by necessity (resumable phase machine) — do not force-split them without preserving the phase/lease/heartbeat invariants documented in surrounding comments.

**Parameters:** DB accessor functions take `(env: AppBindings, ...args)` or rely on `AsyncLocalStorage`-scoped `getDb`; avoid re-introducing manual client threading.

**Return Values:** Prefer explicit discriminated-union result objects over throwing for expected branching outcomes (see Error Handling above).

## Module Design

**Exports:** Named exports throughout; no default exports observed in `src/server/**`. React UI components under `src/client/components/ui/` also favor named exports.

**Barrel Files:** Not used — imports reference specific files directly (e.g. `@server/db/jobs`, `@server/db/file-reviews`), not an aggregating `index.ts`.

**Data contracts:** `src/shared/schema.ts` is the single source of truth for shapes shared between worker and dashboard (Zod schemas + inferred types + literal-union constants like `jobStatuses`, `reviewSeverities`). When adding a new field to a job/file/review shape, update the Zod schema here first — both server and client consume it.

---

*Convention analysis: 2026-07-12*
