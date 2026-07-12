# External Integrations

**Analysis Date:** 2026-07-12

## APIs & External Services

**GitHub (core integration):**
- GitHub App - Receives PR webhook events, posts review comments/checks back to PRs
  - Client: hand-rolled `GitHubClient` in `src/server/core/github.ts` (fetches `https://api.github.com/...` directly, no SDK/Octokit)
  - Auth: App JWT signed with `APP_PRIVATE_KEY`, exchanged for installation access tokens via `https://api.github.com/app/installations/{id}/access_tokens`
  - Related: `https://api.github.com/app` (app metadata), `https://api.github.com/app/installations` (installation listing)
  - Webhook signature verification: `src/server/core/verify.ts`
  - Webhook delivery persistence: `src/server/db/webhook-deliveries.ts`

**GitHub OAuth (dashboard login):**
- `src/server/core/github-oauth.ts` - Authorization Code flow using `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET`
  - Calls `https://api.github.com/user` to fetch the authenticated user's profile
  - Callback URL configured via `AUTH_CALLBACK_URL` (e.g. `.../auth/github/callback`)
  - Dashboard access restricted to usernames in `DASHBOARD_ALLOWED_USERS` env var

**LLM Providers (per-repo model routing):**
- OpenAI - `src/server/models/openai.ts`
- Anthropic - `src/server/models/anthropic.ts`
- Google (Gemini) - `src/server/models/google.ts`
- Cloudflare Workers AI - `src/server/models/cloudflare.ts` (also queries Cloudflare's model catalog API using `CF_ACCOUNT_ID`/`CF_API_TOKEN` for discovery)
  - Model catalog/definitions: `src/server/models/catalog.ts`
  - Provider capability limits (context size, etc.): `src/server/models/limits.ts`
  - Common adapter interface: `src/server/models/types.ts`
  - Routing/orchestration: `src/server/services/model.ts` (`ModelService`)
  - Provider API keys stored encrypted in Postgres (see Auth & Identity / Data Storage below), managed from dashboard `src/server/db/model-configs.ts`

**Codra Telemetry (opt-out, first-party):**
- Anonymous aggregate usage stats sent to `https://codra.run/api/telemetry` (default `TELEMETRY_API_URL`)
  - Implementation: `src/server/core/telemetry.ts`
  - Signed with `TELEMETRY_SECRET` (hardcoded default `codra-telemetry-v1-secret-8f9a2b5c`, overridable)
  - Disable via `TELEMETRY_DISABLED=true`
  - Instance identified by a random UUID persisted in `global_settings` table (`INSTANCE_ID_KEY = 'codra:instance_id'`)

## Data Storage

**Databases:**
- PostgreSQL (external, self-hosted or managed) - primary and only datastore
  - Access path in production: Cloudflare Hyperdrive binding `HYPERDRIVE` → Postgres (connection pooling/edge acceleration)
  - Access path for migrations/tests: direct `DATABASE_URL` / `TEST_DATABASE_URL`
  - Client: `postgres` (postgres.js) wrapped in `src/server/db/client.ts` (`runWithDb`, `getDb`, `queryRows` using `AsyncLocalStorage` for per-request/per-workflow-invocation connection scoping)
  - No ORM; raw parameterized SQL in one module per domain under `src/server/db/`: `jobs.ts`, `file-reviews.ts`, `model-configs.ts`, `repo-configs.ts`, `repositories.ts`, `app-settings.ts`, `stats.ts`, `webhook-deliveries.ts`, `client.ts`
  - Schema/migrations: plain numbered SQL files in `db/migrations/` (`001_initial.sql`, `002_jobs_async_review.sql`, ...), applied sequentially under a Postgres advisory lock by `scripts/migrate.mjs`

**File Storage:**
- Local filesystem only (source diffs/patches handled in-memory via `core/diff.ts`; no object storage/bucket integration detected)

**Caching:**
- Cloudflare KV (`APP_KV` binding) - used for session storage (`src/server/core/sessions.ts`), not general-purpose caching

## Authentication & Identity

**Auth Provider:**
- GitHub OAuth (dashboard user login) - `src/server/core/github-oauth.ts`, `src/server/core/oauth.ts`
- GitHub App installation auth (bot identity for PR actions) - `src/server/core/github.ts`
- Session management: KV-backed sessions (`APP_KV`), created/validated in `src/server/core/sessions.ts`; enforced by `requireSession` middleware in `src/server/app.ts`
- CSRF protection: `requireCsrfHeader` middleware guarding `/api/*` dashboard routes
- Provider API key secrets (OpenAI/Anthropic/Google/Cloudflare) encrypted at rest in Postgres using `LLM_CONFIG_ENCRYPTION_KEY` (`src/server/core/llm-crypto.ts`)

## Monitoring & Observability

**Error Tracking:**
- No third-party error tracking service (e.g. Sentry) detected
- Cloudflare Workers built-in `observability` enabled in `wrangler.jsonc` (logs + traces, 100% head sampling)

**Logs:**
- Structured logging via `src/server/core/logger.ts`
- Cloudflare Workers invocation logs enabled (`observability.logs.invocation_logs: true`)

## CI/CD & Deployment

**Hosting:**
- Cloudflare Workers (single Worker serving both HTTP `fetch` and queue `queue` handlers), custom domain `app.codra.devarshi.dev`
- Deploy pipeline: `npm run deploy` → `vite build` + `cf-typegen` → `migrate` (applies pending SQL migrations against `DATABASE_URL`) → `wrangler deploy`

**CI Pipeline:**
- GitHub Actions (per `CLAUDE.md`: CI installs Chromium and runs browser tests; a CLA check runs on PRs) — check `.github/workflows/` for exact job definitions
- PRs target the `dev` branch, not `main`

## Environment Configuration

**Required env vars (secrets, declared in `wrangler.jsonc`):**
- `APP_PRIVATE_KEY`, `GITHUB_APP_ID`, `GITHUB_APP_WEBHOOK_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `LLM_CONFIG_ENCRYPTION_KEY`, `CF_API_TOKEN`, `CF_ACCOUNT_ID`

**Required env vars (non-secret, `vars` in `wrangler.jsonc`):**
- `APP_URL`, `AUTH_CALLBACK_URL`, `BOT_USERNAME`, `GITHUB_APP_SLUG`, `DASHBOARD_ALLOWED_USERS`, `ENVIRONMENT`

**Database/local-dev only (`.dev.vars`):**
- `DATABASE_URL`, `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`, `TEST_DATABASE_URL`

**Optional:**
- `TELEMETRY_DISABLED`, `TELEMETRY_API_URL`, `TELEMETRY_SECRET`

**Secrets location:**
- Production: Cloudflare Worker secrets (`wrangler secret put ...`), not committed
- Local dev: `.dev.vars` (gitignored), copied from `.dev.vars.example` (no real values)
- Provider LLM API keys: encrypted column(s) in Postgres, encrypted/decrypted via `LLM_CONFIG_ENCRYPTION_KEY` in `src/server/core/llm-crypto.ts`

## Webhooks & Callbacks

**Incoming:**
- `POST /webhook` - GitHub App webhook events (PR opened/synchronize/etc.), signature-verified via `src/server/core/verify.ts` against `GITHUB_APP_WEBHOOK_SECRET`; routed in `src/server/app.ts`
- `GET/POST /auth/*` - GitHub OAuth callback flow (`AUTH_CALLBACK_URL` target: `/auth/github/callback`)

**Outgoing:**
- GitHub REST API calls to post inline review comments/check results back onto the PR (`src/server/core/github.ts`)
- Cloudflare Workers AI catalog API calls for model discovery (`src/server/models/cloudflare.ts`)
- Telemetry POST to `https://codra.run/api/telemetry` (opt-out via `TELEMETRY_DISABLED`)

---

*Integration audit: 2026-07-12*
