---
phase: 05-bitbucket-adapter-webhook-route
verified: 2026-07-13T19:50:00Z
status: passed
score: 8/8 requirements verified
behavior_unverified: 0
overrides_applied: 0
overrides: []
gaps: []
deferred: []
human_verification: []
behavior_unverified_items: []
---

# Phase 5: Bitbucket Adapter & Webhook Route Verification Report

**Phase Goal:** A Bitbucket Cloud pull request receives the same automated AI review — inline findings posted back to the PR — that a GitHub PR already gets, from one Codra instance, without breaking existing GitHub support.

**Verified:** 2026-07-13T19:50:00Z

**Status:** PASSED

## Goal Achievement

The Bitbucket Cloud pipeline is realized end-to-end against the locked decision surface (`D-01..D-21`, `REV-R-A`, `REV-M-1..REV-M-10`, `REV-C-1..REV-C-4`) without breaking the GitHub path. The four protected NREG-02 spec files are byte-identical to the pre-phase base (`67950674..HEAD -- test/webhook-handling.spec.ts test/vcs-regression.spec.ts test/pr-review-pipeline.spec.ts test/review-resilience.spec.ts` — empty diff), and the full node test suite (347 tests across 39 files) plus `npm run typecheck` are both green.

### Requirement Coverage (REQUIREMENTS.md traceability)

| Requirement | Description | Status | Evidence |
| ----------- | ----------- | ------ | -------- |
| BB-01 | Hand-rolled BitbucketClient (core/bitbucket.ts) — no SDK, mirrors GitHubClient | ✓ SATISFIED | `src/server/core/bitbucket.ts` exports `BitbucketClient` class with `getPullRequest` (line 158), `getPullRequestDiff` (line 176), `listPullRequestComments` (line 182), `postPullRequestComment` (line 194), `approvePullRequest` (line 216), `upsertCodeInsightsReport` (line 221), `postCommitBuildStatus` (line 231), plus `BitbucketError` (line 18) and `withRetry` (line 52). All calls use `globalThis.fetch` to `https://api.bitbucket.org/2.0` with `Authorization: Bearer ${token}`. 14 tests in `test/bitbucket-client.spec.ts` GREEN. |
| BB-02 | POST /webhook/bitbucket ingests `pullrequest:created` and `pullrequest:updated` events | ✓ SATISFIED | `src/server/routes/webhook-bitbucket.ts` (`createBitbucketWebhookRouter`) registered in `src/server/app.ts:31` (`app.route('/webhook/bitbucket', createBitbucketWebhookRouter())`). The schema `pullRequestWebhookPayloadSchema` is a discriminated union on `eventName` (`src/shared/bitbucket.ts:59-62`) with `pullRequestCreatedPayloadSchema` + `pullRequestUpdatedPayloadSchema`. 10 tests in `test/bitbucket-webhook.spec.ts` GREEN. |
| BB-03 | X-Hub-Signature HMAC with per-repo secret, fail-closed | ✓ SATISFIED | `routes/webhook-bitbucket.ts:99-128` implements the 5-step HMAC ordering: `getVcsCredentialSecrets` → `decryptSecret` → `verifyWebhookSignature({ signatureHeaderName: 'x-hub-signature' })`. Missing secret row / tampered body / missing signature header → 401. `verifyWebhookSignature` (`src/server/core/verify.ts:23`) is the generalized helper; `verifyGitHubWebhookSignature` (line 57) is the byte-identical GitHub shim. `git diff 67950674..HEAD -- src/server/routes/webhook.ts` is empty — NREG-02 holds. |
| BB-04 | `pullrequest:updated` commit-hash dedup via `mostRecentJobForPullRequest` | ✓ SATISFIED | `routes/webhook-bitbucket.ts:166-185` calls `mostRecentJobForPullRequest(env, { vcsProvider: 'bitbucket', workspace, owner: workspace, repo: repoSlug, prNumber })` and compares `bytesToHex(recent.commit_sha)` to `incomingCommitSha`. Match → `200 { ok: true, ignored: true, reason: 'metadata_only_edit' }`. `mostRecentJobForPullRequest` accessor exists at `src/server/db/jobs.ts:1137`. Asserted in `test/bitbucket-webhook.spec.ts` (Test 3 metadata_edit). |
| BB-05 | PR diff fed into existing `core/diff.ts` pipeline (200-file / 8,000-line caps) | ✓ SATISFIED | `src/server/vcs/bitbucket.ts:286` calls `parseUnifiedDiff(raw)` from `@server/core/diff` (no new chunking code). `core/review.ts:1574` already runs the existing `filterReviewableFiles(parseUnifiedDiff(rawDiff, config.review), config.review)` against the diff returned by `vcs.getPullRequestDiff(...)` — both providers share the same downstream pipeline. The 50-subrequest/invocation budget is honored via the existing `budgetAwareChunkFileLimit` + `FRESH_INVOCATION_YIELD_SECONDS` machinery. |
| REV-01 | Inline findings anchored by file `path` + `to`/`from` line (no `commit_id`) | ✓ SATISFIED | `BitbucketAdapter.submitReview` (`src/server/vcs/bitbucket.ts:202-253`) calls `anchorForComment` (line 299) which walks the parsed `FileDiff` (line 286) to translate `VcsReviewComment.position` → `{ path, line, line_type }` with antigravity's flattened-hunk-line search (`line.position === comment.position`). For `del` kind, R-03 inverse mapping applies (`from = oldLineNumber, line_type = 'removed'`). POST body uses `{ content: { raw }, inline: { path, to | from } }` — no `commit_id`. REV-R-A dedup-before-POST ensures retries are idempotent. Asserted in `test/bitbucket-adapter.spec.ts` (position→line translation cases). |
| REV-02 | Code Insights report (PASSED/FAILED + summary), keyed for in-place retry | ✓ SATISFIED | `BitbucketAdapter.createStatusCheck` (line 128) and `updateStatusCheck` (line 146) PUT `/repositories/{workspace}/{repo}/commit/{commit}/reports/codra-review` with `{ title, details, report_type: REPORT_TYPE ('BUG'), result: REPORT_RESULT[0] ('PASSED') }`. PUT semantics provide idempotent in-place retry. `report_type` and `result` enums imported from `src/server/bitbucket/constants.ts` (single source of truth per REV-M-4). `link` field added when `ref` is non-empty. Asserted in `test/bitbucket-adapter.spec.ts` (createStatusCheck + updateStatusCheck cases). |
| REV-03 | Commit build status (SUCCESSFUL/FAILED), keyed by stable `key` | ✓ SATISFIED | `BitbucketAdapter.updateStatusCheck:191-196` POSTs `/commit/{commit}/statuses/build` with `key: 'codra-review'` (HARDCODED regardless of `ref` per REV-M-10) and `state` mapped per REV-M-9: `conclusion === 'success' \|\| 'neutral' → 'SUCCESSFUL'` (NOT 'INPROGRESS' — the antigravity merge-blocking fix), `conclusion === 'failure' \| 'cancelled' → 'FAILED'`, `status === 'in_progress' → 'INPROGRESS'`. The hardcoded `key` makes retries upsert to the same status row. Asserted in `test/bitbucket-adapter.spec.ts` (REV-M-9 verdict mapping + REV-M-10 key opacity). |
| NREG-02 | Full existing test suite green after every phase; existing GitHub review behavior unchanged | ✓ SATISFIED | `git diff 67950674..HEAD -- test/webhook-handling.spec.ts test/vcs-regression.spec.ts test/pr-review-pipeline.spec.ts test/review-resilience.spec.ts` is empty (1 line of empty diff = no changes). `git diff 67950674..HEAD -- src/server/routes/webhook.ts` is empty — the GitHub route file is untouched. The `verifyGitHubWebhookSignature` shim (`src/server/core/verify.ts:57`) produces byte-identical results for the GitHub path. `npm test` runs 347 tests across 39 files PASS. `npm run typecheck` exits 0. |

### Wave Plan Coverage

| Plan | Wave | Status | Key Outputs |
| ---- | ---- | ------ | ----------- |
| 05-01 | Wave 0 (DB foundation) | ✓ VERIFIED | `db/migrations/005_bitbucket_repo_identity.sql` (idempotent migration; nullable `installation_id`, `workspace TEXT NULL`, UNIQUE constraint `repositories_vcs_provider_workspace_repo_key`, index `idx_repositories_workspace_repo`); `findRepositoryByBitbucketIdentity`; `getOrCreateRepository` provider-branched (REV-C-1); `insertJob` widened (REV-C-1 + REV-R-B); `findExistingJobForHead` + `supersedeOlderJobs` vcsProvider-aware (D-02 / REV-C-4); `mostRecentJobForPullRequest` (D-04); `updateJobStatusCheckRef` (REV-R-E); `recordWebhookDelivery` `repositoryId` passthrough (REV-R-D); `JobRow` + `mapJob` + `jobSummarySchema` widening (R-01 / REV-C-3). 5 RED tests turned GREEN. |
| 05-02 | Wave 1 (client + contracts + HMAC) | ✓ VERIFIED | `src/shared/bitbucket.ts` (Zod schemas: discriminated-union `pullRequestWebhookPayloadSchema` on `eventName`, `prCommentSchema` REV-M-2 Bitbucket-native, `codeInsightsReportSchema` REV-M-4 PASSED/FAILED-only, `commitBuildStatusSchema`); `src/server/bitbucket/constants.ts` (REPORT_TYPE='BUG', REPORT_RESULT=['PASSED','FAILED'], LINE_TYPES, BUILD_STATUS_STATE — single source of truth); `src/server/core/bitbucket.ts` (`BitbucketClient` + `BitbucketError` + `withRetry` + 7 methods); `src/server/core/verify.ts` generalized (`verifyWebhookSignature` + GitHub shim byte-identical). 40 tests across 3 spec files GREEN. |
| 05-03 | Wave 2 (VCS adapter + branching) | ✓ VERIFIED | `src/server/vcs/bitbucket.ts` (`BitbucketAdapter implements VcsProvider`, async static `create` factory for credential read + decrypt, REV-R-A combined marker+summary + dedup, REV-M-9 `comment`→`SUCCESSFUL` verdict mapping, REV-M-10 ref opacity for build-status POST); `src/server/vcs/types.ts` widening (REV-M-5 `jobIdHint?`, REV-M-10 ref-opacity JSDoc); `src/server/services/vcs.ts` (D-14 `forRepo` branches on `job.repositoryVcsProvider`, D-15 `forProvider` widens with `NotImplementedError`); `src/server/services/formatter.ts` (D-13 emoji `severityIcon` gated by `provider === 'bitbucket'`; GitHub `<img>` path byte-identical); `src/server/core/review.ts` (REV-C-2 provider-aware prepare-phase ref handling; R-02 finalize gate widened to `if (job.statusCheckRef \|\| job.checkRunId)` at line 1471, line 1031 prepare-phase guard unchanged; REV-M-7 `baseSha: string \| null`); `src/server/core/job-recovery.ts` (REV-M-8 reconciliation routes through `VcsService.forRepo`, OR widening). 27 new tests across 4 spec files GREEN. |
| 05-04 | Wave 3 (webhook route) | ✓ VERIFIED | `src/server/routes/webhook-bitbucket.ts` (16-step handler: rawBody capture → identity-projection parse (REV-M-6) → `getVcsCredentialSecrets` → `decryptSecret` → `verifyWebhookSignature` → full payload parse (REV-M-1 eventName injection) → D-20 repository-not-registered short-circuit → D-04 metadata-edit dedup → `recordWebhookDelivery` (REV-R-D repositoryId passthrough) → `ingestReviewWebhookEvent({ provider: 'bitbucket' })` → D-17 response shapes); `src/server/app.ts` mounts the route at `/webhook/bitbucket` (no middleware); `src/server/core/webhook-ingest.ts` widened (`effectiveProvider = input.provider ?? reviewRequest.repositoryVcsProvider ?? 'github'` threads through `findExistingJobForHead` + `supersedeOlderJobs` — closes Phase-3 deferred item); `src/server/core/review.ts` `ReviewRequest` widened with `repositoryVcsProvider?` + `repositoryWorkspace?`. 12 new tests across 2 spec files GREEN. |

### Locked Decision Compliance (05-CONTEXT.md `decisions` section)

| Decision | Surface | Status |
| -------- | ------- | ------ |
| D-01: Migration 005 makes `repositories.installation_id` nullable, adds `workspace TEXT NULL`, adds Bitbucket UNIQUE | `db/migrations/005_bitbucket_repo_identity.sql` | ✓ IMPLEMENTED — DO $$ information_schema guard for DROP NOT NULL; ADD COLUMN IF NOT EXISTS; pg_constraint-guarded UNIQUE; CREATE INDEX IF NOT EXISTS. Idempotent under re-run (asserted in `test/migration-005-idempotency.spec.ts`). |
| D-02: `findExistingJobForHead` + `supersedeOlderJobs` byte-identical for no-arg GitHub callers, provider-aware for explicit arg | `src/server/db/jobs.ts:890-910` (`findExistingJobForHead`); `:1170-1225` (`supersedeOlderJobs`) | ✓ IMPLEMENTED — default `vcsProvider = input.vcsProvider ?? 'github'`; bitbucket branch reads `r.workspace`, GitHub branch reads `r.installation_id` (byte-identical when caller supplies `installationId`). Tests 1-5 of `test/webhook-ingest.spec.ts` remain UNCHANGED + GREEN. |
| D-03: `findRepositoryByBitbucketIdentity(env, { workspace, repoSlug })` accessor | `src/server/db/repositories.ts:77` | ✓ IMPLEMENTED — parameterized query `SELECT id FROM repositories WHERE vcs_provider='bitbucket' AND workspace=$1 AND repo=$2`. Used by `routes/webhook-bitbucket.ts:150` for the D-20 short-circuit. |
| D-04: `mostRecentJobForPullRequest({ vcsProvider, workspace, owner, repo, prNumber })` returns most recent JobRow | `src/server/db/jobs.ts:1137` | ✓ IMPLEMENTED — returns JobRow (with `commit_sha` BYTEA); route reads via `bytesToHex(recent.commit_sha)` and compares to incoming hex string. |
| D-05: `core/verify.ts` generalized to `verifyWebhookSignature({ secret, signatureHeaderName, rawBody })`; GitHub shim byte-identical | `src/server/core/verify.ts:23-64` | ✓ IMPLEMENTED — generalized helper + 3-line `verifyGitHubWebhookSignature` shim. `git diff 67950674..HEAD -- src/server/routes/webhook.ts` empty. |
| D-06: Bitbucket route lives in `src/server/routes/webhook-bitbucket.ts` (separate file) | `src/server/routes/webhook-bitbucket.ts` | ✓ IMPLEMENTED — separate file mirrors `routes/webhook.ts` convention. |
| D-07: Bitbucket delivery dedup via `recordWebhookDelivery` with `event_name` from `X-Event-Key` | `src/server/db/webhook-deliveries.ts`; `routes/webhook-bitbucket.ts:195-202` | ✓ IMPLEMENTED — `(deliveryId: xRequestUUID, eventName: xEventKey, owner: null, repo: null, repositoryId, payload)` — REV-R-D `repositoryId` passthrough. |
| D-08: `submitReview` sequence: inline-comments-with-dedup → combined marker+summary → optional approve | `src/server/vcs/bitbucket.ts:202-253` | ✓ IMPLEMENTED — REV-R-A combined marker+summary as the FINAL post; dedup-before-POST on inline comments; approve only when `verdict === 'approve'`. |
| D-09: `findExistingReviewForCommit` filters for marker prefix + commit substring | `src/server/vcs/bitbucket.ts:255-268` | ✓ IMPLEMENTED — filters `item.body.startsWith('<!-- codra:job=') && item.body.includes('commit=${commitSha}')`. Returns `{ ref: String(matched.id) }` or null. |
| D-10: `createStatusCheck` PUT `/commit/{commit}/reports/codra-review` with `report_type='BUG'`, `result='PASSED'`, returns `{ ref: 'codra-review' }` | `src/server/vcs/bitbucket.ts:128-144` | ✓ IMPLEMENTED — `client.upsertCodeInsightsReport` PUT; `ref` is the caller-chosen report id 'codra-review' (idempotent). |
| D-11: `updateStatusCheck` PUTs report THEN POSTs build status with `key='codra-review'`, REV-M-9 verdict mapping | `src/server/vcs/bitbucket.ts:146-200` | ✓ IMPLEMENTED — PUT happens before POST; build status HARDCODES `key='codra-review'` regardless of `ref` (REV-M-10); `comment` verdict → `SUCCESSFUL` (REV-M-9). |
| D-12: `submitReview` translates `VcsReviewComment.position` → `{path, to/from, line_type}` via flattened hunk lines | `src/server/vcs/bitbucket.ts:299-323` | ✓ IMPLEMENTED — `anchorForComment` walks `file.hunks.lines` for `line.position === comment.position`; R-03 inverse for `del` kind (`from: oldLineNumber, line_type: 'removed'`). No `VcsReviewComment` shape change. |
| D-13: Formatter emoji fallback gated by `provider === 'bitbucket'` | `src/server/services/formatter.ts:17` | ✓ IMPLEMENTED — `severityIcon(severity, options?)` returns emoji when `options?.provider === 'bitbucket'` (🚨 P0 / ⚠️ P1 / ⚠️ P2 / ℹ️ P3 / 💬 nit); existing `<img>` path byte-identical for `provider === 'github'` (or undefined). |
| D-14: `VcsService.forRepo` reads `job.repositoryVcsProvider`, branches to `BitbucketAdapter.create` (lease-safety) | `src/server/services/vcs.ts:42-57` | ✓ IMPLEMENTED — async static `create` factory reads + decrypts the credential; rejection propagates to `core/review.ts:388-394` lease-release try/catch. |
| D-15: `VcsService.forProvider` accepts `provider: 'bitbucket'`, throws `NotImplementedError` | `src/server/services/vcs.ts:73-79` | ✓ IMPLEMENTED — typed `NotImplementedError('Bitbucket forProvider is not yet supported')`. |
| D-16: `app.route('/webhook/bitbucket', createBitbucketWebhookRouter())` alongside GitHub route | `src/server/app.ts:31` | ✓ IMPLEMENTED — new import line 9 + new route line 31; GitHub registration at line 30 untouched. |
| D-17: Route response shapes distinct from GitHub: `{ok, eventName, reviewed}` for queued; `{ok, ignored, reason}` for dedup-skipped | `routes/webhook-bitbucket.ts:152-157, 178-183, 207-208, 246-250, 252-257, 261-264` | ✓ IMPLEMENTED — six distinct response shapes pattern-matched from `ingestReviewWebhookEvent`'s discriminated-union result. |
| D-18: No existing test file edited | `git diff 67950674..HEAD -- test/webhook-handling.spec.ts test/vcs-regression.spec.ts test/pr-review-pipeline.spec.ts test/review-resilience.spec.ts` | ✓ IMPLEMENTED — empty diff. New Bitbucket tests live in NEW spec files. |
| D-19: Defensive lower-casing of `workspace + repo_slug` from payload | `routes/webhook-bitbucket.ts:96-97` | ✓ IMPLEMENTED — `toLowerCase()` applied after identity-projection parse, before credential lookup + row resolution + reviewRequest propagation. Same normalized value flows end-to-end. |
| D-20: Repository-not-registered short-circuit returns `202 ignored, reason: 'repository_not_registered'` | `routes/webhook-bitbucket.ts:151-158` | ✓ IMPLEMENTED — `findRepositoryByBitbucketIdentity(...) === null` returns 202 immediately. |
| D-21: Reuse `filterReviewableFiles` + `truncateFileDiff` + chunking pipeline for Bitbucket diff caps | `src/server/vcs/bitbucket.ts:286` (parseUnifiedDiff); `core/review.ts:1574` (filterReviewableFiles) | ✓ IMPLEMENTED — no new chunking code; the existing pipeline runs against both providers' diffs. |
| REV-M-1: EventName injected from `X-Event-Key` AFTER rawBody capture, schema is `{eventName, ...parsedBody}` | `routes/webhook-bitbucket.ts:141-145` | ✓ IMPLEMENTED — `const envelope = { eventName: xEventKey, ...(typeof parsedBody === 'object' && parsedBody !== null ? parsedBody : {}) };` |
| REV-M-6: HMAC flow = rawBody capture → identity-projection parse → getVcsCredentialSecrets → decryptSecret → verifyWebhookSignature → full payload parse | `routes/webhook-bitbucket.ts:76-145` | ✓ IMPLEMENTED — exact step ordering documented in file header (lines 17-56). |
| REV-M-7: `ReviewRequest.baseSha` becomes `string \| null` | `src/server/core/review.ts` ReviewRequest type | ✓ IMPLEMENTED — adapter populates `baseSha: parsed.data.pullrequest.destination.commit.hash ?? ''`. |
| REV-R-A: Combined marker+summary as the FINAL post; inline dedup-before-POST | `src/server/vcs/bitbucket.ts:218-253` | ✓ IMPLEMENTED — `dedup.has(...)` skip path before each inline POST; combined marker+summary at the END; verdict-gated approve. |
| REV-M-9: `verdict === 'comment'` → `'SUCCESSFUL'` (NOT 'INPROGRESS') | `src/server/vcs/bitbucket.ts:178-186` | ✓ IMPLEMENTED — `else { state = 'SUCCESSFUL'; }` covers both 'success' and 'neutral' (the comment verdict). |
| REV-M-10: Build-status POST HARDCODES `key='codra-review'` regardless of `ref` | `src/server/vcs/bitbucket.ts:188-196` | ✓ IMPLEMENTED — `key: 'codra-review'` literal at line 192; `ref` only used for the Code Insights PUT path. |
| REV-M-5: `VcsSubmitReviewInput.jobIdHint?` widening | `src/server/vcs/types.ts` | ✓ IMPLEMENTED — adapter uses `input.jobIdHint ?? 'unknown'` for the marker comment. |

## Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `db/migrations/005_bitbucket_repo_identity.sql` | Migration: nullable installation_id, workspace column, Bitbucket UNIQUE, idempotent | ✓ VERIFIED | File exists, 69 lines. Re-run safe via DO $$ information_schema guard, ADD COLUMN IF NOT EXISTS, pg_constraint guard, CREATE INDEX IF NOT EXISTS. Asserted GREEN by `test/migration-005-idempotency.spec.ts`. |
| `src/server/bitbucket/constants.ts` | Single source of truth for REPORT_TYPE, REPORT_RESULT, LINE_TYPES, BUILD_STATUS_STATE | ✓ VERIFIED | File exists, 15 lines. `REPORT_TYPE='BUG' as const` (verified against Atlassian OpenAPI per Plan 02 deviation); `REPORT_RESULT=['PASSED','FAILED']` (antigravity correction). |
| `src/shared/bitbucket.ts` | Zod schemas (webhook payload discriminated union, prComment, codeInsightsReport, commitBuildStatus) | ✓ VERIFIED | File exists, 122 lines. Discriminated union on `eventName` (REV-M-1); prCommentSchema is a union of `topLevelPrCommentSchema` (content-only) + `inlinePrCommentSchema` (per Plan 02 deviation 3); inbound schemas `.passthrough()` to preserve Bitbucket's supersets, outbound schemas `.strict()`. 23 schema tests GREEN. |
| `src/server/core/bitbucket.ts` | Hand-rolled BitbucketClient + BitbucketError + withRetry + 7 methods | ✓ VERIFIED | File exists, 240 lines. All 7 methods implemented with `Authorization: Bearer ${token}` header; `withRetry` retries on 429/5xx/TimeoutError with exponential backoff + Retry-After support. 14 client tests GREEN. |
| `src/server/core/verify.ts` | Generalized `verifyWebhookSignature` + GitHub shim byte-identical | ✓ VERIFIED | File exists, 64 lines. `verifyGitHubWebhookSignature` is a 3-line shim producing byte-identical results for the GitHub path. 4 verifier tests GREEN. |
| `src/server/vcs/bitbucket.ts` | BitbucketAdapter implements VcsProvider (7 methods + async `create`) | ✓ VERIFIED | File exists, 343 lines. Async static `create` factory; combined marker+summary; emoji severityIcon is in formatter; verdict mapping; ref opacity. 14 adapter tests GREEN. |
| `src/server/routes/webhook-bitbucket.ts` | 16-step handler with HMAC ordering + D-04 dedup + D-20 short-circuit | ✓ VERIFIED | File exists, 281 lines. All 16 steps documented in file header (lines 17-56). 10 route tests GREEN. |
| `src/server/app.ts` | Mount `/webhook/bitbucket` route | ✓ VERIFIED | New import line 9 + new registration line 31. `app.route('/webhook', createWebhookRouter())` at line 30 unchanged. |
| `src/server/core/webhook-ingest.ts` | Provider-aware via `effectiveProvider` chain | ✓ VERIFIED | `effectiveProvider = input.provider ?? reviewRequest?.repositoryVcsProvider ?? 'github'` at line 47; threaded through `findExistingJobForHead` (line 58) and `supersedeOlderJobs` (line 94). 7 ingest tests GREEN (Tests 1-5 UNCHANGED, Tests 6-7 NEW). |
| `src/server/db/jobs.ts` | `findRepositoryByBitbucketIdentity`, `findExistingJobForHead`/`supersedeOlderJobs` provider-aware, `mostRecentJobForPullRequest`, `updateJobStatusCheckRef` | ✓ VERIFIED | All accessors present and wired. JobRow widening includes `repositoryVcsProvider`, `repositoryWorkspace`, `status_check_ref`. |
| `src/server/db/repositories.ts` | `findRepositoryByBitbucketIdentity` + provider-branched `getOrCreateRepository` | ✓ VERIFIED | `findRepositoryByBitbucketIdentity` at line 77; `getOrCreateRepository` Bitbucket branch binds NULL for `installation_id` (REV-R-B defense-in-depth). |
| `src/server/db/webhook-deliveries.ts` | `repositoryId?: number \| null` widening | ✓ VERIFIED | When `repositoryId` is supplied, the legacy SELECT-by-owner/repo lookup is bypassed. |
| `src/server/services/vcs.ts` | `forRepo` branches on `repositoryVcsProvider`; `forProvider` widens | ✓ VERIFIED | BitbucketAdapter.create for 'bitbucket'; NotImplementedError placeholder for forProvider('bitbucket'). 8 vcs-service tests GREEN. |
| `src/server/services/formatter.ts` | `severityIcon` options-bag with emoji fallback for 'bitbucket' | ✓ VERIFIED | Emoji path gated by `options?.provider === 'bitbucket'`; existing GitHub `<img>` path byte-identical. 31 formatter tests GREEN (7 NEW + 24 UNCHANGED). |
| `src/server/core/review.ts` | REV-C-2 provider-aware prepare-phase; R-02 finalize gate widening; REV-M-7 baseSha nullable | ✓ VERIFIED | Line 1031: prepare-phase `if (job.checkRunId)` guard UNCHANGED. Line 1471: finalize gate widened to `if (job.statusCheckRef \|\| job.checkRunId)`. `Number(checkRun.ref)` confined to `vcs.name === 'github'` branch (line 718). `updateJobStatusCheckRef` call at line 734 persists the Bitbucket string ref unchanged. |
| `src/server/core/job-recovery.ts` | REV-M-8 reconciliation routes through `VcsService.forRepo` | ✓ VERIFIED | No production-code `new GitHubService` references in reconciliation (only a docstring comment). 5 job-recovery-provider tests GREEN. |

## Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `routes/webhook-bitbucket.ts` | `core/webhook-ingest.ts` | `ingestReviewWebhookEvent({ ..., provider: 'bitbucket' })` | ✓ WIRED | Step 14 of the handler (line 234); result pattern-matched into D-17 response shapes (lines 244-264). |
| `routes/webhook-bitbucket.ts` | `core/verify.ts` | `verifyWebhookSignature({ secret, signatureHeaderName: 'x-hub-signature', signature, rawBody })` | ✓ WIRED | Step 7 (line 120); byte-identical raw body from `c.req.text()` (line 76). |
| `routes/webhook-bitbucket.ts` | `db/vcs-credentials.ts` | `getVcsCredentialSecrets` BEFORE HMAC | ✓ WIRED | Step 5 (line 100); ordering enforced by file-level docstring + grep verification. |
| `routes/webhook-bitbucket.ts` | `db/repositories.ts` | `findRepositoryByBitbucketIdentity` for D-20 | ✓ WIRED | Step 9 (line 150). |
| `routes/webhook-bitbucket.ts` | `db/jobs.ts` | `mostRecentJobForPullRequest` for D-04 dedup | ✓ WIRED | Step 10 (line 167). |
| `routes/webhook-bitbucket.ts` | `db/webhook-deliveries.ts` | `recordWebhookDelivery` with `repositoryId` passthrough | ✓ WIRED | Step 12 (line 195); REV-R-D `repositoryId` flows from step 9's lookup. |
| `core/webhook-ingest.ts` | `db/jobs.ts` | `findExistingJobForHead` + `supersedeOlderJobs` with `vcsProvider: effectiveProvider` | ✓ WIRED | Lines 58 + 94. The Phase-3 deferred item is closed: the no-arg GitHub path resolves `effectiveProvider = 'github'` and produces byte-identical SQL; the explicit Bitbucket path passes `vcsProvider: 'bitbucket'`. |
| `VcsService.forRepo` | `BitbucketAdapter.create` | Static async factory reads + decrypts credential | ✓ WIRED | `src/server/services/vcs.ts:57`; credential read can reject, propagating to `core/review.ts:388-394` lease-release try/catch. |
| `BitbucketAdapter.submitReview` | `core/diff.ts` | `parseUnifiedDiff(raw)` for `anchorForComment` walk | ✓ WIRED | Line 286; cached diff from `env.APP_KV.get(`diff:${job.id}`)` (line 277). |
| `BitbucketClient` | `api.bitbucket.org/2.0` | `globalThis.fetch` with `Authorization: Bearer ${token}` | ✓ WIRED | `BITBUCKET_API_BASE_URL = 'https://api.bitbucket.org/2.0'` (line 14); Bearer header on every request (line 135). |
| `app.ts` | `routes/webhook-bitbucket.ts` | `app.route('/webhook/bitbucket', createBitbucketWebhookRouter())` | ✓ WIRED | Line 31. No new middleware (webhook signatures ARE the auth). |

## Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `BitbucketAdapter.submitReview` | `combinedBody` | `input.jobIdHint ?? 'unknown'`, `input.commitSha`, `input.summaryBody` | ✓ FLOWING — marker + summary composed from real review output (line 242). |
| `BitbucketAdapter.updateStatusCheck` | `state` (build status) | `input.conclusion` + `input.status` mapped per REV-M-9 | ✓ FLOWING — verdict drives terminal `SUCCESSFUL`/`FAILED`/`INPROGRESS`. |
| `routes/webhook-bitbucket.ts` | `repositoryId` | `findRepositoryByBitbucketIdentity` lookup | ✓ FLOWING — real DB row id flows into `recordWebhookDelivery` and the ingest helper. |
| `routes/webhook-bitbucket.ts` | `recent.commit_sha` | `mostRecentJobForPullRequest` BYTEA column | ✓ FLOWING — `bytesToHex` round-trip produces the hex string that matches `incomingCommitSha` (line 175). |
| `core/webhook-ingest.ts` | `effectiveProvider` | `input.provider ?? reviewRequest?.repositoryVcsProvider ?? 'github'` | ✓ FLOWING — deterministic chain; the default 'github' resolution preserves NREG-02 byte-identity for the 5 protected tests. |

## Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Full node test suite green | `npx vitest run --project node` | 39 files, 347 tests PASS | ✓ PASS |
| Focused Bitbucket tests green | `npx vitest run --project node test/bitbucket-webhook.spec.ts test/bitbucket-adapter.spec.ts test/bitbucket-client.spec.ts test/bitbucket-schema.spec.ts test/bitbucket-identity.spec.ts test/jobs-provider-filter.spec.ts test/repositories-provider-bypass.spec.ts test/job-recovery-provider.spec.ts` | 8 files, 82 tests PASS | ✓ PASS |
| Protected NREG-02 specs unmodified + green | `git diff 67950674..HEAD -- test/webhook-handling.spec.ts test/vcs-regression.spec.ts test/pr-review-pipeline.spec.ts test/review-resilience.spec.ts` + `npx vitest run --project node test/webhook-handling.spec.ts test/vcs-regression.spec.ts test/pr-review-pipeline.spec.ts test/review-resilience.spec.ts test/webhook-ingest.spec.ts` | empty diff; 5 files, 35 tests PASS | ✓ PASS |
| `npm run typecheck` clean | `npm run typecheck` | exit 0 | ✓ PASS |
| Migration 005 idempotent | `npx vitest run --project node test/migration-005-idempotency.spec.ts` | GREEN | ✓ PASS |
| GitHub webhook route file unchanged | `git diff 67950674..HEAD -- src/server/routes/webhook.ts` | empty | ✓ PASS |
| `verifyGitHubWebhookSignature` shim byte-identical | `npx vitest run --project node test/verify.spec.ts` | GREEN — shim byte-identity asserted explicitly for tampered-correct-missing-prefix-missing-signature inputs | ✓ PASS |
| BitbucketAdapter.submitReview sequence | `npx vitest run --project node test/bitbucket-adapter.spec.ts` | 14 tests PASS — combined marker+summary as final post, dedup-before-POST, approve gated | ✓ PASS |
| REV-M-9 verdict → SUCCESSFUL mapping | `grep -n "neutral.*SUCCESSFUL" src/server/vcs/bitbucket.ts` + adapter spec | Mapping present (line 184); spec asserts `conclusion: 'neutral'` → `state: 'SUCCESSFUL'` | ✓ PASS |
| REV-M-10 build-status key='codra-review' | `grep -n "'codra-review'" src/server/vcs/bitbucket.ts` | HARDCODED at line 192 (build-status POST) + line 143 (Code Insights ref) | ✓ PASS |

### Probe Execution

No conventional `scripts/*/tests/probe-*.sh` probes are declared by the phase. All verification is via the Vitest spec suite.

## Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| BB-01 | 05-02 | Hand-rolled BitbucketClient mirroring GitHubClient | ✓ SATISFIED | `src/server/core/bitbucket.ts` (240 lines); 14 tests in `test/bitbucket-client.spec.ts` PASS |
| BB-02 | 05-04 | POST /webhook/bitbucket ingests pullrequest:created + pullrequest:updated | ✓ SATISFIED | `src/server/routes/webhook-bitbucket.ts`; 10 tests in `test/bitbucket-webhook.spec.ts` PASS |
| BB-03 | 05-04 | X-Hub-Signature HMAC with per-repo secret, fail-closed | ✓ SATISFIED | Steps 5-7 of handler; 401 paths in spec GREEN |
| BB-04 | 05-04 | pullrequest:updated commit-hash dedup | ✓ SATISFIED | Step 10 of handler; `mostRecentJobForPullRequest` + `bytesToHex` compare |
| BB-05 | 05-03 | PR diff + diffstat into existing core/diff.ts pipeline | ✓ SATISFIED | `parseUnifiedDiff` reuse in `BitbucketAdapter`; existing `filterReviewableFiles` pipeline at `core/review.ts:1574` |
| REV-01 | 05-03 | Inline findings anchored by path + to/from line | ✓ SATISFIED | `anchorForComment` walks `FileDiff`; `submitReview` POSTs `/comments` with `{content, inline: {path, to\|from}}` |
| REV-02 | 05-03 | Code Insights report (PASSED/FAILED + summary), keyed for in-place retry | ✓ SATISFIED | `upsertCodeInsightsReport` PUT `/commit/{commit}/reports/codra-review`; REPORT_RESULT binary enum |
| REV-03 | 05-03 | Commit build status keyed by stable key | ✓ SATISFIED | `postCommitBuildStatus` POST `/commit/{commit}/statuses/build` with `key: 'codra-review'`; REV-M-9 verdict mapping |
| NREG-02 | All waves (cross-cutting) | Full existing test suite green; existing GitHub review behavior unchanged | ✓ SATISFIED | Empty diff for protected spec files + routes/webhook.ts; 347 tests PASS; typecheck clean |

## Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| — | — | None found | — | No `TBD`, `FIXME`, `XXX`, `TODO`, or `placeholder` markers in Bitbucket-produced files. No `return null`, `return {}`, `return []`, or `=> {}` stubs in handler paths. No hardcoded empty data at rendering sites. No console-log-only implementations. |
| `test/webhook-ingest.spec.ts` | — | Vitest warning: `vi.hoisted()` + `vi.mock()` inside `dbDescribe` callback | ⚠️ INFO | Pre-existing warning (existed before Phase 5 — the protected-tests-required contract); vitest still hoists correctly. Not a Phase 5 issue. |

**Debt-marker gate:** No unreferenced `TBD`, `FIXME`, or `XXX` markers in any file modified or created by Phase 5. The 5 deviations documented in the plan summaries (`334f595`, `bb26cf5`, `474a8ab`, `779cc68`/`6f58880`, `d02d2f1`) are intentional plan-time fixes with explicit rationale.

## Human Verification Required

None — all behavior-dependent truths have a corresponding test exercising the transition or invariant (e.g., `submitReview` sequence → `test/bitbucket-adapter.spec.ts`; HMAC verification → `test/verify.spec.ts`; `pullrequest:updated` dedup → `test/bitbucket-webhook.spec.ts`; verdict mapping → `test/bitbucket-adapter.spec.ts`). The only thing that requires a live Bitbucket workspace to truly verify is that the Code Insights report renders correctly in Bitbucket's UI (research flagged `<img>` rendering as unverified); but the suite verifies the byte-shape of every emitted payload, which is what the API contract requires.

## Gaps Summary

No gaps. All 8 requirements (BB-01..05, REV-01..03) are satisfied; the NREG-02 cross-cutting invariant holds; the four protected spec files are byte-identical to the pre-phase base (`67950674..HEAD`); `npm test` is green at 347 tests; `npm run typecheck` is clean.

---

_Verified: 2026-07-13T19:50:00Z_
_Verifier: Claude (gsd-verifier)_