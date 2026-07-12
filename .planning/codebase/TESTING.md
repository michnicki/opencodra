# Testing Patterns

**Analysis Date:** 2026-07-12

## Test Framework

**Runner:**
- Vitest 4, config: `vitest.config.ts`
- Two Vitest "projects" defined:
  - `node` project — `test/**/*.spec.ts` (excludes `test/browser/**`), environment `node`, setup file `test/setup.ts`, `fileParallelism: false`
  - `browser` project — `test/browser/**/*.spec.tsx`, real Chromium via `@vitest/browser-playwright`, setup file `test/browser/setup.ts`

**Assertion Library:**
- Vitest's built-in `expect` (globals enabled via `test.globals: true`), plus `@testing-library/jest-dom` matchers for browser/component tests.

**Run Commands:**
```bash
npm test              # scripts/test.mjs: loads env files, applies migrations to TEST_DATABASE_URL, then `vitest run`
npm run test:watch    # vitest (watch mode)
npm run test:browser  # vitest run --project browser
npx vitest run test/diff.spec.ts   # single file (migrations must already be applied once)
```

`npm test` is a wrapper script (`scripts/test.mjs`), not raw `vitest run` — it loads env files in priority order (`.env.test`, `.env.local`, `.env`, `.dev.vars`, `.env.test.example`), then runs migrations, then spawns vitest. Do not bypass it for the first run in a fresh environment.

## Test File Organization

**Location:**
- All specs live in a flat `test/` directory (not co-located with source), named `*.spec.ts` for Node tests and `*.spec.tsx` under `test/browser/` for browser/component tests.
- Shared test infrastructure also lives in `test/`: `test/setup.ts` (global setup/mocks), `test/helpers.ts` (env/DB fixtures), `test/github-fetch-mock.ts` (GitHub API fetch stub), `test/mocks/` (module-level mocks, e.g. `cloudflare:workers`).

**Naming:**
- `<feature>.spec.ts`, one file generally per subsystem: `diff.spec.ts`, `model-service.spec.ts`, `resumable-queue.spec.ts`, `webhook-handling.spec.ts`, `review-flow.spec.ts` (largest, 35.8K — full pipeline scenarios), `pr-review-pipeline.spec.ts` (end-to-end against a real `GitHubClient`).

**Structure:** No fixed directory nesting — flat list of ~22 spec files plus support files. A large integration-style spec is acceptable when it exercises full job lifecycle behavior (e.g. `review-flow.spec.ts`, `async-batch-review.spec.ts`).

## Test Structure

**Suite Organization** (from `test/diff.spec.ts`):
```typescript
import { parseUnifiedDiff, ... } from '@server/core/diff';
import { defaultRepoConfig } from '@shared/schema';

describe('Diff Engine Deep Dive', () => {
  const sampleDiff = `diff --git a/src/example.ts ...`;

  describe('parseUnifiedDiff', () => {
    it('tracks new lines and GitHub positions for standard diffs', () => {
      const [file] = parseUnifiedDiff(sampleDiff);
      expect(file.path).toBe('src/example.ts');
    });
  });
});
```
- Nested `describe` blocks: outer names the subsystem/feature, inner names the function/scenario group.
- `it('<behavior description in plain English>', ...)` — test names read as behavior specs, not method names.
- Raw diff/webhook payload fixtures are inlined as template literals directly in the test file rather than loaded from separate fixture files.

**Patterns:**
- Setup: tests requiring the database call `createTestEnv()` from `test/helpers.ts` to build a full `AppBindings` mock, optionally overriding specific bindings.
- Long-running DB-backed flows get a global timeout bump: `vi.setConfig({ testTimeout: 300000 })` in `test/setup.ts` (5 minutes) because Postgres-backed review flow tests can be slow locally/CI.
- `fileParallelism: false` in `vitest.config.ts` — tests share one Postgres database, so cross-file DB race conditions are avoided by running spec files serially, not in parallel workers. A database cleanup `beforeEach` exists but is currently commented out in `test/setup.ts` (disabled to debug race conditions) — do not assume tables are wiped between tests; write specs that create their own uniquely-identified rows (distinct job IDs, PR numbers, etc.) rather than relying on a clean table.

## Mocking

**Framework:** Vitest's `vi` (`vi.fn`, `vi.mock`, `vi.stubGlobal`, `vi.setConfig`).

**Cloudflare bindings are mocked, not the database:**
- `MemoryKV` (`test/helpers.ts`) — in-memory Map-backed `KVNamespace` replacement for `APP_KV`.
- `MockQueue` (`test/helpers.ts`) — records sent messages in `.sent` array instead of hitting a real Cloudflare Queue; used to assert `REVIEW_QUEUE.send()` calls.
- `MockWorkflow` — records `.create()` calls and exposes fake `.get(id).terminate()`.
- `MockAssets` — returns a synthetic HTML response so SPA-serving code paths don't need a real Vite build in tests.
- `cloudflare:workers` module itself is mocked globally in `test/setup.ts` via `vi.mock('cloudflare:workers', () => ({ WorkflowEntrypoint: class {} }))` since that module only exists in the Workers runtime.
- The real Postgres connection (`HYPERDRIVE.connectionString`) is NOT mocked — tests run against `TEST_DATABASE_URL`, a real disposable Postgres database, via the actual `getDb`/`queryRows` code path. This is deliberate: DB behavior (transactions, constraints, migrations) is tested for real rather than mocked.

**GitHub API mocking pattern** (`test/github-fetch-mock.ts`):
```typescript
export function installGitHubFetchMock(fixtures: GitHubFetchMockFixtures) {
  const originalFetch = globalThis.fetch;
  async function handler(input, init) {
    const url = new URL(...);
    if (url.hostname !== 'api.github.com') {
      return new Response('{}', { status: 200 }); // swallow telemetry calls, etc.
    }
    // route by method + path, record call, return scripted Response
  }
  globalThis.fetch = handler as any;
  return { calls, restore: () => { globalThis.fetch = originalFetch; } };
}
```
- Stubs `globalThis.fetch` directly (no MSW/nock) so the real `GitHubClient` (`src/server/core/github.ts`) runs unmodified end-to-end against a fake `api.github.com`.
- Non-GitHub hosts (e.g. the `codra.run` telemetry beacon fired by `core/telemetry.ts` on every finalize) get a fast synthetic 200 so tests never make real outbound network calls.
- Supports scripted response sequences (e.g. `reviewResponses: [{status:200},{status:422}]`) to test retry/backoff paths deterministically.
- Every call is recorded (`method, path, accept, body`) so tests assert exact GitHub API interactions (e.g. correct PATCH body, correct Accept header for a preview API).

**What to Mock:**
- Cloudflare-only runtime bindings (KV, Queue, Workflow, Assets, `cloudflare:workers`)
- Outbound HTTP to GitHub and third-party LLM providers
- `window.matchMedia` / `ResizeObserver` for jsdom-based component tests (stubbed globally in `test/setup.ts`)

**What NOT to Mock:**
- The Postgres database — use the real `TEST_DATABASE_URL` and real `db/*` modules.
- Core business logic under test (diff parsing, model routing, review orchestration) — exercised directly, not stubbed.

## Fixtures and Factories

**Test Data:**
- No dedicated fixture-factory library; fixtures are built as plain object literals per test/spec file (e.g. `GitHubFetchMockFixtures` passed into `installGitHubFetchMock`).
- `test/helpers.ts` provides reusable environment builders:
  ```typescript
  export function createTestEnv(overrides: Partial<AppBindings> = {}): AppBindings {
    return { AI: { async run() { return {...canned AI response...}; } }, APP_KV: new MemoryKV(), ... , ...overrides };
  }
  ```
- `requiredEnv(key)` / `unusedEnv(key)` helpers enforce that every required env var used by a test is explicitly present, and throw a descriptive error if a test tries to read an env var the current suite doesn't declare a need for — keeps the required-env surface intentional and self-documenting.
- `saveTestProviderApiKey(env, providerName, apiKey)` — seeds an encrypted provider API key row directly into Postgres via `queryRows`, for tests exercising model routing against Google/Cloudflare providers. Comments in this helper explain why certain Gemini test model IDs must be seeded manually (they aren't part of the real catalog).

**Location:**
- `test/helpers.ts` (env/DB fixtures), `test/github-fetch-mock.ts` (HTTP fixtures) — both imported directly by spec files, no auto-discovery.

## Coverage

**Requirements:** Not enforced/configured — no coverage thresholds found in `vitest.config.ts` or `package.json`.

**View Coverage:**
```bash
npx vitest run --coverage   # not wired into package.json scripts; run ad hoc if needed
```

## Test Types

**Unit Tests:**
- Pure logic modules tested directly with inline fixtures: `diff.spec.ts`, `model-limits.spec.ts`, `token-tracker.spec.ts`, `chunk-concurrency.spec.ts`, `formatter.spec.ts`, `model-output.spec.ts`.

**Integration Tests:**
- DB + queue + model-service interplay tested against a real Postgres instance and mocked Cloudflare bindings: `resumable-queue.spec.ts`, `async-batch-review.spec.ts`, `review-resilience.spec.ts`, `workflow-finalize-fresh-instance.spec.ts`, `scheduled-maintenance.spec.ts`, `model-config-cache.spec.ts`.
- Full pipeline tests combine the real `GitHubClient` (via `github-fetch-mock.ts`), real DB, and the review orchestrator: `pr-review-pipeline.spec.ts`, `review-flow.spec.ts` (largest spec, end-to-end job lifecycle scenarios), `webhook-handling.spec.ts`, `api.spec.ts` (dashboard API, largest at 34.4K).

**E2E Tests:**
- `test:browser` project runs real Chromium via Playwright for client-side component tests under `test/browser/` (jsdom is used for lighter tests instead when a full browser isn't required — both `environment: 'node'`-with-jsdom-polyfills-in-setup and a genuine browser project coexist). Not a full user-facing E2E harness (no full app boot + real browser navigation against the deployed SPA) — scope is component/DOM-level.

## Common Patterns

**Async Testing:**
```typescript
it('does X', async () => {
  const env = createTestEnv();
  const result = await someAsyncOperation(env, ...);
  expect(result).toEqual(...);
});
```
Standard `async`/`await` with real timers; long DB-backed operations rely on the global 300000ms test timeout rather than per-test overrides.

**Error Testing:**
- Scripted failure sequences via mock fetch responses (e.g. `reviewResponses: [{status:500}, {status:200}]`) to verify `RetryableModelError`/backoff logic without real network flakiness.
- Retryable-vs-fatal classification helpers (`isRetryableModelError`, `isTimeoutMessage`, `matchesAnyTransientSubstring`) are exercised directly with crafted error messages/status codes rather than only through end-to-end retries.

---

*Testing analysis: 2026-07-12*
