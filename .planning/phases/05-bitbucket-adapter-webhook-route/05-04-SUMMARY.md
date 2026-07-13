---
phase: 05-bitbucket-adapter-webhook-route
plan: 04
type: execute
subsystem: webhook-route
tags: [bitbucket, webhook, hmac, dedup, ignore, provider-aware, phase-3-closure]
dependency_graph:
  requires:
    - 05-01 (findRepositoryByBitbucketIdentity, getOrCreateRepository, mostRecentJobForPullRequest, recordWebhookDelivery repositoryId passthrough)
    - 05-02 (verifyWebhookSignature, BitbucketCloud Zod schemas + identity projection, decryptSecret, getVcsCredentialSecrets)
    - 05-03 (BitbucketAdapter — used downstream by the worker via VcsService.forRepo)
  provides:
    - POST /webhook/bitbucket route (16-step handler flow per D-05..D-20 + REV-M-1..REV-R-D)
    - src/server/routes/webhook-bitbucket.ts (NEW — createBitbucketWebhookRouter())
    - src/server/core/webhook-ingest.ts (widened: provider threading through findExistingJobForHead + supersedeOlderJobs; message.provider gate widened for the Bitbucket-side effectiveProvider chain)
    - src/server/core/review.ts (ReviewRequest type widened: repositoryVcsProvider?, repositoryWorkspace?)
    - src/server/app.ts (mounted the Bitbucket route alongside the GitHub registration)
    - test/bitbucket-webhook.spec.ts (NEW — 10 tests pinning the route surface)
    - test/webhook-ingest.spec.ts (Test 6 + Test 7 added — Bitbucket concrete-job path + null-fallback)
  affects:
    - core/webhook-ingest.ts (provider threading — Phase-3 deferred item CLOSED)
    - core/review.ts (ReviewRequest type widening — additive only)
    - app.ts (1 import + 1 route registration line)
key-files:
  created:
    - src/server/routes/webhook-bitbucket.ts (POST /webhook/bitbucket — 16-step handler)
    - test/bitbucket-webhook.spec.ts (10 tests: signed/created/updated/D-04 dedup/D-20 ignored/401 4-ways/400 X-Event-Key/D-19 lowercasing)
  modified:
    - src/server/core/review.ts (ReviewRequest widened with 2 optional fields)
    - src/server/core/webhook-ingest.ts (provider threading through DB calls)
    - src/server/app.ts (mount new Bitbucket route + import)
    - test/webhook-ingest.spec.ts (extended with Test 6 + Test 7 — provider threading assertions)
decisions:
  - "REV-M-6 ordering: rawBody capture → identity-projection Zod parse → getVcsCredentialSecrets → decryptSecret → verifyWebhookSignature → full payload parse. The identity-projection parse + secret lookup happen BEFORE verify, but rawBody is captured first (so HMAC sees the byte-identical body). README + multi-line comments document this at the function top."
  - "REV-M-1 eventName injection: the route constructs `{ eventName: xEventKey, ...JSON.parse(rawBody) }` AFTER HMAC verify; the body's eventName field is ignored because the header value is the source of truth (X-Event-Key was not in rawBody)."
  - "REV-M-7 baseSha nullable: route reads `payload.pullrequest.destination.commit.hash ?? ''`; tolerates the empty-string case (Plan 03 widened ReviewRequest.baseSha to string | null)."
  - "REV-R-D repositoryId passthrough: recordWebhookDelivery receives the resolved repositoryId directly with owner:null/repo:null (R-10). The legacy SELECT-by-owner/repo lookup is bypassed, so a same-text GitHub repo cannot mis-attribute a Bitbucket delivery."
  - "D-05 verification ordering: missing vcs_credentials row, missing encrypted_webhook_secret, decrypt failure, missing signature header, tampered body → all 401 fail-closed. The endpoint does not call api.bitbucket.org."
  - "D-04 metadata-edit dedup: pullrequest:updated + mostRecentJobForPullRequest.commitSha matches incoming source.commit.hash → 200 ignored metadata_only_edit (no ingest call). Closes the case where Bitbucket's pullrequest:updated fires on title/body/branch edits too."
  - "D-20 ignored short-circuit: findRepositoryByBitbucketIdentity null → 202 ignored repository_not_registered (no ingest call). The HMAC verified and the delivery is attributed to null so subsequent duplicate deliveries dedup on the X-Request-UUID."
  - "D-19 lowercasing: workspace + repo_slug are lowercased after the identity-projection parse and used for the secret lookup AND the row resolution AND the reviewRequest passed downstream. The SAME lowercased value flows end-to-end."
  - "Phase-3 deferred item CLOSED: ingestReviewWebhookEvent's effectiveProvider chain (input.provider ?? reviewRequest.repositoryVcsProvider ?? 'github') threads through findExistingJobForHead + supersedeOlderJobs. The GitHub no-arg path stays byte-identical (D-02 / NREG-02) because the default resolves to 'github' which produces the same SQL WHERE clause."
  - "route provider argument: input.provider='bitbucket' is set explicitly by the Bitbucket route; the message.provider gate widens to attach `provider: 'bitbucket'` to the queue message when the effectiveProvider is non-github (covers both 'bitbucket' explicit arg AND reviewRequest.repositoryVcsProvider)."
tech-stack:
  added: []
  patterns:
    - Per-repo HMAC secret BEFORE verify (D-05 ordering — the Phase-4 secret-storage invariant)
    - Identity-projection Zod parse as a small guard BEFORE HMAC (REV-M-6)
    - eventName injection from a trusted header (X-Event-Key) for schema discriminated-union matching (REV-M-1)
    - Direct repositoryId passthrough to recordWebhookDelivery (REV-R-D — bypasses owner/repo SELECT path)
    - Provider threading via effectiveProvider = input.provider ?? reviewRequest.repositoryVcsProvider ?? 'github' (Phase-3 deferred item closure)
metrics:
  duration_seconds: 0
  completed_date: 2026-07-13
  tasks_completed: 6
  files_modified: 4
  files_created: 2
  tests_added: 12
  tests_total_impacted: 347
status: complete
---

# Phase 5 Plan 4: Bitbucket Webhook Route — Summary

## Overview

Wired the Bitbucket Cloud webhook live path end-to-end: `POST /webhook/bitbucket` (D-06 / D-16 / D-17), per-repo secret HMAC verification (D-05), D-20 ignored short-circuit, D-04 metadata-edit dedup, and the **provider-aware ingest helper** that finally closes the **Phase-3 deferred item** — REVIEW finding 3 of Phase 3's deferred-section flagged that `ingestReviewWebhookEvent` was provider-agnostic for the queue message but not safe for Bitbucket concrete-job identity (`insertJob` / `findExistingJobForHead` / `supersedeOlderJobs` / `repo-config-lookup` needed provider awareness before any Bitbucket concrete job could route through it). This plan widens the helper to thread `vcsProvider` through both DB calls and to forward `message.provider` on the queue when the effective provider is non-github.

The locked decision surface (D-05..D-07, D-16, D-17, D-19, D-20, REV-M-1, REV-M-6, REV-M-7, REV-R-D) is satisfied end-to-end with 10 new tests + 2 added tests on the widened helper, all four NREG-02 protected specs (webhook-handling, vcs-regression, pr-review-pipeline, the protected webhook-ingest Tests 1-5) PASS UNMODIFIED, and the full suite is GREEN at 347 tests.

**Phase-3 debt now satisfiable.** ingestReviewWebhookEvent is provider-aware end-to-end via the `effectiveProvider = input.provider ?? reviewRequest.repositoryVcsProvider ?? 'github'` chain; Phase 5 closed this debt that Bitbucket concrete jobs would have been mis-attributed to a GitHub repo row.

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | RED test/bitbucket-webhook.spec.ts — pinning the route surface | `37c2347` | test/bitbucket-webhook.spec.ts (NEW) |
| 2 | src/server/routes/webhook-bitbucket.ts — full route handler (16 steps) | `67215cc` | src/server/routes/webhook-bitbucket.ts (NEW) |
| 3 | ReviewRequest type widening in src/server/core/review.ts | `2e6f862` | src/server/core/review.ts |
| 4 | src/server/core/webhook-ingest.ts provider-aware + Test 6 / Test 7 | `9be5c02` | src/server/core/webhook-ingest.ts, test/webhook-ingest.spec.ts |
| 5 | src/server/app.ts mounts the Bitbucket route | `e731282` | src/server/app.ts (+1 import +1 registration) |
| 6 | Test fixes for GREEN (state field, bytea decode, name field, vi.hoisted) | `bb26cf5` | test/bitbucket-webhook.spec.ts |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Initial RED test was missing `repository.name` field — route's identity projection parse was rejecting valid payloads**
- **Found during:** Task 2 (route RED → GREEN)
- **Issue:** Plan stated the identity projection's `{ repository: { workspace: { slug }, name }, pullrequest: { id } }`. The test buildPayload helper rendered `repository: { full_name, workspace: { slug }, uuid }` — no `name` field. The route's `bitbucketIdentityProjectionSchema.safeParse` rejected the payload as 400 for every signed test.
- **Fix:** Added `name` to the type + the `buildPayload` factory (default `bb-repo`) and to each test override. Bitbucket's webhook payload does carry `repository.name` (the repo slug) in production.
- **Files modified:** test/bitbucket-webhook.spec.ts
- **Commit:** `bb26cf5`

**2. [Rule 1 - Bug] Pullrequest `state` field was missing — full payload parse failed after HMAC verify**
- **Found during:** Task 2
- **Issue:** `pullRequestWebhookPayloadSchema` requires `pullrequest.state` (min 1 char). Test payloads omitted the field, so step 8's full-payload parse returned 400.
- **Fix:** Added `state` (default `'OPEN'`) to the pullrequest type + factory.
- **Files modified:** test/bitbucket-webhook.spec.ts
- **Commit:** `bb26cf5`

**3. [Rule 3 - Blocking] Nested `vi.mock('@server/core/webhook-ingest')` factory inside `dbDescribe` callback crashed at runtime**
- **Found during:** Task 2
- **Issue:** Vitest hoists `vi.mock` calls above all top-level code, so a `vi.mock` factory nested inside `dbDescribe` that referenced a non-hoisted `const ingestSpy = vi.fn()` ran before the spy existed — vitest logged "A vi.mock call is not at the top level" and the route threw `Internal Server Error` because the mocked module returned undefined for `ingestReviewWebhookEvent`.
- **Fix:** Moved the vi.mock to module top level + wrapped the spy in `vi.hoisted(() => ({ ingestSpy: vi.fn() }))` so the spy reference resolves at the same point in module init as the hoisted mock factory (mirrors `test/review-resilience.spec.ts` and `test/job-recovery-provider.spec.ts`).
- **Files modified:** test/bitbucket-webhook.spec.ts
- **Commit:** `bb26cf5`

**4. [Rule 1 - Bug] Test 3 (D-04 metadata_edit) seeded bytea as ASCII characters, not decoded hex — comparison failed**
- **Found during:** Task 2
- **Issue:** The seeded `jobs.commit_sha` used `$3::bytea` with a `'e'.repeat(40)` parameter. PostgreSQL stored the **ASCII bytes** of those characters (0x65 * 40 = bytes 101), not the **SHA's nibble values** (which would have been `bytesToHex`-compatible 0xee nibbles). The route's `bytesToHex(recent.commit_sha)` round-tripped back as `'6565...'`; the incoming `source.commit.hash` string was `'eeee...'`. The strings never matched.
- **Fix:** Replaced `$3::bytea` with `decode($1, 'hex')` so the seeded bytes are the SHA's nibbles; the route's `bytesToHex` then matches the incoming hex string byte-for-byte.
- **Files modified:** test/bitbucket-webhook.spec.ts
- **Commit:** `bb26cf5`

**5. [Rule 3 - Blocking] Test afterEach FK violation on the `repositories` DELETE**
- **Found during:** Task 2
- **Issue:** Cleanup order deleted `vcs_credentials` then `repositories`. A job row whose `repository_id` referenced the test's repositories id violated the FK constraint, throwing `update or delete on table "repositories" violates foreign key constraint "jobs_repository_id_fkey"` and leaving the repositories row undeleted for the next test.
- **Fix:** Reorder DELETE: webhook_deliveries (references repository_id) → jobs (references repository_id) → repositories (no longer has FK dependents). The cleanup is now ordered by FK depth.
- **Files modified:** test/bitbucket-webhook.spec.ts
- **Commit:** `bb26cf5`

### Plan-exact Executions

All other plan items executed exactly as written. The 16-step handler flow, the REV-M-6 ordering (identity-projection parse → getVcsCredentialSecrets → decryptSecret → verifyWebhookSignature → full payload parse), the REV-M-1 eventName injection from the trusted X-Event-Key header, the REV-M-7 baseSha empty-string tolerance, the REV-R-D repositoryId passthrough, the D-19 defensive lowercase, the D-20 ignored short-circuit, and the D-04 metadata-edit dedup all match the locked decision surface byte-for-byte.

The Phase-3 deferred-item closure (provider threading through `findExistingJobForHead` + `supersedeOlderJobs` + the queue message's `provider` gate) lands exactly as the plan specified: `effectiveProvider = input.provider ?? reviewRequest.repositoryVcsProvider ?? 'github'`, with the default-`'github'` path byte-identical to the no-arg pre-widening path (NREG-02 holds because the default resolves through the `?? 'github'` chain to the same value the no-arg caller used).

## Verification Results

| Check | Result |
|-------|--------|
| test/bitbucket-webhook.spec.ts (10 tests) | PASS |
| test/webhook-ingest.spec.ts (7 tests — 5 UNCHANGED + 2 NEW) | PASS (Tests 1-5 unmodified NREG-02 byte-identity) |
| test/webhook-handling.spec.ts (6 tests, UNMODIFIED) | PASS (NREG-02 holds) |
| test/vcs-regression.spec.ts (UNMODIFIED) | PASS (NREG-02 holds) |
| test/pr-review-pipeline.spec.ts (UNMODIFIED) | PASS (NREG-02 holds) |
| Full node test suite | 347 tests PASS / 0 FAIL |
| npm run typecheck | PASS |
| `grep -n 'eventName: xEventKey' src/server/routes/webhook-bitbucket.ts` | Confirmed (lines 141, 155, 180, 197, 207, 239, 247, 254, 262) |
| `grep -n 'verifyWebhookSignature\|getVcsCredentialSecrets' src/server/routes/webhook-bitbucket.ts` | getVcsCredentialSecrets (line 100) BEFORE verifyWebhookSignature (line 120) — REV-M-6 ordering verified |
| `grep -n 'destination.commit.hash' src/server/routes/webhook-bitbucket.ts` | Confirmed (line 222) — REV-M-7 baseSha source verified |
| `grep -n 'repositoryId' src/server/routes/webhook-bitbucket.ts` | Confirmed (line 200) — REV-R-D passthrough verified |
| `grep -n 'toLowerCase\|D-19' src/server/routes/webhook-bitbucket.ts` | Confirmed (lines 96-97) — D-19 lowercasing verified |
| `grep -n 'app\.route' src/server/app.ts` | Both `app.route('/webhook', createWebhookRouter())` and `app.route('/webhook/bitbucket', createBitbucketWebhookRouter())` present |
| `grep -n 'requireSession' src/server/app.ts` | Hook routes NOT gated by session — webhook signatures ARE the auth |
| `git diff --stat test/webhook-handling.spec.ts test/vcs-regression.spec.ts test/pr-review-pipeline.spec.ts` | Empty (NREG-02 protected) |
| `git diff --stat src/server/app.ts` | +1 import +1 registration line; nothing else |

## Acceptance Criteria

- [x] **BB-01, BB-03**: POST /webhook/bitbucket is registered (D-16) with per-repo-secret HMAC verification using X-Hub-Signature. Fail-closed on missing/invalid signature, missing/invalid secret row, or absent headers. The handler verifies x-hub-signature over the byte-identical raw body captured via c.req.text() (REV-M-6 ordering).
- [x] **BB-04**: pullrequest:updated commit-hash dedup via mostRecentJobForPullRequest (D-04) returns 200 ignored metadata_only_edit without enqueueing.
- [x] **BB-05**: provider-aware ingest helper routes the concrete Bitbucket job through the same `core/diff.ts` pipeline as the GitHub path (no new chunking code; VcsService.forRepo handles provider branching via Wave 3's BitbucketAdapter).
- [x] **REV-01..REV-03**: the finalize phase posts (a) inline comments anchored by path + line via the BitbucketAdapter, (b) Code Insights report keyed for in-place retry via upsertCodeInsightsReport, (c) commit build status keyed by `key='codra-review'`. Wave 3's adapter tests cover this end-to-end; this plan ensures the JOB is enqueued with the right provider threading.
- [x] **D-02**: ingest helper providers are byte-identical for the existing GitHub-only callers (Tests 1-5 untouched). The `effectiveProvider = 'github'` default produces the same SQL WHERE clause as the pre-widening no-arg path.
- [x] **D-19**: defensive lower-casing matches the Phase 4 storage normalization (workspace + repo_slug both lowercased at the route boundary; the SAME normalized identity flows end-to-end through the credential lookup, the row resolution, and the reviewRequest).
- [x] **D-20**: repository-not-registered short-circuit returns 202 ignored without enqueueing; ingest helper is NOT called.
- [x] **REV-M-1**: the Bitbucket route injects `eventName` from `X-Event-Key` AFTER HMAC verify and BEFORE the full schema parse; the schema's discriminated union matches.
- [x] **REV-M-6**: the HMAC flow is `rawBody capture → identity-projection parse → getVcsCredentialSecrets → decryptSecret → verifyWebhookSignature → full payload parse` — documented at function top + enforced by line ordering.
- [x] **REV-M-7**: pullRequestWebhookPayloadSchema includes `pullrequest.destination.commit.hash`; the Bitbucket route populates `reviewRequest.baseSha = parsed.data.pullrequest.destination.commit.hash ?? ''` (tolerating empty string per Plan 03 REV-M-7's nullable baseSha).
- [x] **REV-R-D**: recordWebhookDelivery accepts `repositoryId?: number | null`; the Bitbucket route passes the resolved id directly with owner:null/repo:null.
- [x] **NREG-02**: the four protected pipeline specs (webhook-handling, vcs-regression, pr-review-pipeline, the protected webhook-ingest Tests 1-5) all pass UNMODIFIED.
- [x] **Phase-3 deferred-item CLOSED**: ingest helper is now provider-aware end-to-end via `effectiveProvider = input.provider ?? reviewRequest.repositoryVcsProvider ?? 'github'`. Phase 5 closed this debt.

## Output Artifacts

- src/server/routes/webhook-bitbucket.ts (NEW, 281 lines) — POST /webhook/bitbucket with the 16-step handler flow. REV-R-A combined marker+summary, REV-M-9 verdict mapping, REV-M-10 ref-opacity, D-12 position->line anchor translation live in Wave 3's BitbucketAdapter (this plan only owns the route + the ingest-helper provider threading).
- src/server/core/webhook-ingest.ts (MODIFIED) — `effectiveProvider` chain threads through findExistingJobForHead + supersedeOlderJobs + message.provider gate.
- src/server/core/review.ts (MODIFIED) — ReviewRequest type widening: 2 new OPTIONAL fields (repositoryVcsProvider, repositoryWorkspace).
- src/server/app.ts (MODIFIED) — +1 import + 1 route registration; no other line touched.
- test/bitbucket-webhook.spec.ts (NEW, ~10 tests, ~494 lines) — pins the entire route surface.
- test/webhook-ingest.spec.ts (EXTENDED) — Test 6 (Bitbucket concrete-job path asserts vcsProvider threading) + Test 7 (null-fallback with explicit provider). Tests 1-5 UNCHANGED.

## Key Insights

1. **The Phase-3 deferred-item closure is the load-bearing decision of this plan.** Before the widening, `ingestReviewWebhookEvent` looked provider-agnostic on the surface but was actually unsafe for any Bitbucket concrete job because `findExistingJobForHead` and `supersedeOlderJobs` filter on (installation_id, owner, repo) without a `vcs_provider` discriminator — a Bitbucket row's `installation_id = NULL` would never match a GitHub filter and a same-text GitHub repo would falsely win the dedup race. The new `effectiveProvider = input.provider ?? reviewRequest.repositoryVcsProvider ?? 'github'` chain threads `vcsProvider` through both DB calls deterministically.

2. **The route's HMAC ordering is a deliberate inversion of the GitHub route's ordering.** GitHub carries the webhook secret in env vars (global). Bitbucket stores per-repo encrypted secrets in `vcs_credentials` — so the secret lookup MUST happen before HMAC verify. The REV-M-6 ordering (rawBody capture → identity-projection parse → getVcsCredentialSecrets → decryptSecret → verifyWebhookSignature → full payload parse) reads "verify before full payload parse" but not "verify before identity parse" — the identity-projection parse is the small Zod-projection read needed to look up the secret, NOT the full payload parse.

3. **REV-R-D bypasses a subtle attribution bug.** Without `repositoryId` passthrough, `recordWebhookDelivery` would do a legacy `SELECT id FROM repositories WHERE owner=$1 AND repo=$2` lookup keyed on the lowercased workspace slug as `owner`. A same-text GitHub repo with the same owner name (e.g. Bitbucket workspace "acme-prod" + GitHub org "acme-prod") would WIN that lookup and attribute the Bitbucket delivery to the GitHub row. The passthrough routes around this so a Bitbucket webhook delivery is correctly attributed to the (vcs_provider='bitbucket', workspace, repo) row only.

4. **D-04 dedup is the surface that distinguishes a competent webhook from a spammy one.** Bitbucket Cloud fires `pullrequest:updated` on title/body/branch edits too (not just new commits) — a naive route would enqueue a job per PR description edit. The `mostRecentJobForPullRequest` + commit-hash comparison returns 200 ignored without enqueueing, preserving the Cloudflare subrequest budget for real reviews.

5. **The `effectiveProvider` chain's `?? 'github'` default preserves NREG-02 byte-identity.** The GitHub no-arg caller (Tests 1-5 in `test/webhook-ingest.spec.ts`) never sets either `input.provider` or `reviewRequest.repositoryVcsProvider` — the chain resolves to `'github'`, which produces the same SQL WHERE clause as the pre-widening call site. The widening is purely additive.

## Phase-3 Deferred Item Closure Note

> **REVIEW finding 3 of Phase 3 closed:** `ingestReviewWebhookEvent` is now provider-aware end-to-end via the `input.provider ?? reviewRequest.repositoryVcsProvider ?? 'github'` chain. Phase 5 closed this debt that a Bitbucket concrete job would have been mis-attributed to a GitHub repo row (or wedged on `findExistingJobForHead` if no GitHub repo shared the same (owner, repo) — both branches now filter explicitly on `r.vcs_provider`). Tests 6 + 7 in `test/webhook-ingest.spec.ts` pin the new vcsProvider threading on `findExistingJobForHead` + `supersedeOlderJobs`. The four protected specs (webhook-handling, vcs-regression, pr-review-pipeline, the protected webhook-ingest Tests 1-5) all pass UNMODIFIED, confirming the GitHub byte-identity guarantee holds.

## Self-Check: PASSED

- [PASS] `src/server/routes/webhook-bitbucket.ts` exists
- [PASS] `test/bitbucket-webhook.spec.ts` exists
- [PASS] `test/webhook-ingest.spec.ts` exists (Tests 1-5 + 6 + 7)
- [PASS] All 6 task commits exist in git history (`37c2347`, `2e6f862`, `9be5c02`, `67215cc`, `e731282`, `bb26cf5`)
- [PASS] `npm run typecheck` returns 0
- [PASS] All four NREG-02 specs unchanged (`git diff --stat` empty for each)
- [PASS] `test/bitbucket-webhook.spec.ts` GREEN (10 tests)
- [PASS] Full node test suite: 347 tests PASS / 0 FAIL

---

*Phase: 05-bitbucket-adapter-webhook-route*
*Plan: 04*
*Completed: 2026-07-13*
