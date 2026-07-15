# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What Codra Is

Self-hosted AI code review for GitHub pull requests, running entirely on Cloudflare (Workers, Queues, KV, Hyperdrive, Workers AI) with an external PostgreSQL database. A GitHub App webhook enqueues review jobs; the Worker's queue consumer runs LLM review passes over the PR diff and posts inline findings back to GitHub. A React dashboard manages repos, model routing, job history, and DLQ replay.

## Commands

```bash
npm run dev          # Vite client build --watch + wrangler dev --local (worker on :8787)
npm run build        # vite build + cf-typegen (regenerates src/server/worker-env.d.ts)
npm run typecheck    # tsc --noEmit
npm test             # Full suite: applies migrations to TEST_DATABASE_URL, then vitest run
npm run test:watch   # vitest watch mode
npm run migrate      # Apply db/migrations/*.sql (uses DATABASE_URL)
npm run deploy       # build + migrate + wrangler deploy
```

Testing requires a disposable Postgres database via `TEST_DATABASE_URL` (env files loaded in order: `.env.test`, `.env.local`, `.env`, `.dev.vars`, `.env.test.example`). To run a single test file, make sure migrations have been applied once (`npm test` does this), then:

```bash
npx vitest run test/diff.spec.ts
```

Tests run with `fileParallelism: false` because they share a database. Cloudflare bindings (KV, Queue, ASSETS) are mocked in `test/setup.ts` / `test/helpers.ts`.

Local dev needs `.dev.vars` (copy from `.dev.vars.example`): GitHub App + OAuth credentials, `LLM_CONFIG_ENCRYPTION_KEY`, Cloudflare API token, and both `DATABASE_URL` (migrations) and `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` (worker runtime).

## Pull Requests

Open PRs against the fork's default branch (`main`). No Contributor License Agreement (CLA) is required — contributions are accepted under AGPL-3.0.

## Architecture

**Single Worker, two entry points** (`src/server/index.ts`): `fetch` serves the Hono HTTP app (webhooks, OAuth, dashboard API, SPA assets) and `queue` consumes review jobs from the `codra-review-jobs` queue (batch size 1, concurrency 1, DLQ `codra-review-dlq`). Both are wrapped in `runWithDb`, which provides a request-scoped postgres.js client over Hyperdrive via AsyncLocalStorage — DB modules call `getDb`/`queryRows` without threading a client through.

**Path aliases** (vite + vitest + tsconfig): `@server`, `@client`, `@shared`, and `@` (= client).

**Shared contract** (`src/shared/schema.ts`): Zod schemas define every data shape — queue messages, repo config, job/file statuses, model output, API responses — and are consumed by both worker and dashboard. Model output is validated against these schemas (with `jsonrepair` fallback in `core/model-output.ts`). Change data shapes here first.

**Review pipeline** (`src/server/core/review.ts`): the heart of the system. Jobs are *resumable and phase-based* — prepare → review → finalize — with each phase re-enqueued as a separate queue message. Per-file review results are persisted (`db/file-reviews.ts`) so a retried job skips already-reviewed files. Jobs use lease/heartbeat ownership and a supersede check (a newer push cancels the in-flight job). Model failures classified as retryable (`RetryableModelError`) return `{ action: 'retry', delaySeconds }` to the queue consumer rather than failing the job. `core/job-recovery.ts` runs best-effort maintenance before/after every batch.

**Model layer**: `services/model.ts` (`ModelService`) routes to per-provider adapters in `src/server/models/` (openai, anthropic, google, cloudflare) with a catalog in `models/catalog.ts`. Provider API keys are managed from the dashboard, stored in Postgres encrypted with `LLM_CONFIG_ENCRYPTION_KEY` (`core/llm-crypto.ts`). Repos can define model chains, fallbacks, and size-based overrides (`db/model-configs.ts`, `db/repo-configs.ts`). Prompts live in `src/server/prompts/`.

**HTTP app** (`src/server/app.ts`): `/webhook` (GitHub App events, signature-verified in `core/verify.ts`), `/auth` (GitHub OAuth, KV-backed sessions), `/api/*` (dashboard API, guarded by `requireSession` + `requireCsrfHeader` middleware). SPA routes are served through the Worker (`run_worker_first` in wrangler.jsonc) so auth can gate them; everything else falls through to static assets.

**Database**: raw SQL (no ORM) through modules in `src/server/db/`, one per table/domain. Migrations are plain numbered SQL files in `db/migrations/`, applied sequentially by `scripts/migrate.mjs` under a Postgres advisory lock.

**Client** (`src/client/`): React 19 SPA with React Router, Tailwind 4, Radix UI primitives in `components/ui/`, pages in `pages/`. Talks to `/api/*` via `lib/api.ts`; several pages poll (`hooks/use-polling.ts`).

**Worker bindings** (wrangler.jsonc): `HYPERDRIVE` (Postgres), `APP_KV` (sessions), `REVIEW_QUEUE`, `AI` (Workers AI models), `ASSETS` (built SPA). After changing bindings, run `npm run cf-typegen` to regenerate `src/server/worker-env.d.ts`.
