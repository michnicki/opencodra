---
phase: 05-bitbucket-adapter-webhook-route
plan: 01
subsystem: db-foundation
tags: [migration, db, schema, providers, bitbucket, tdd]
dependency_graph:
  requires: []
  provides:
    - migration-005-bitbucket-repo-identity
    - findRepositoryByBitbucketIdentity
    - getOrCreateRepository provider-branched
    - findExistingJobForHead vcsProvider-aware
    - supersedeOlderJobs vcsProvider-aware
    - mostRecentJobForPullRequest
    - updateJobStatusCheckRef
    - recordWebhookDelivery repositoryId-passthrough
    - insertJob repositoryId-bypass + vcsProvider/workspace widening
    - jobSummarySchema widened (nullable installationId, R-01 surface, statusCheckRef)
  affects:
    - db/jobs.ts
    - db/repositories.ts
    - db/webhook-deliveries.ts
    - shared/schema.ts
    - core/job-recovery.ts (skip non-github rows)
    - services/vcs.ts (forRepo accepts nullable installationId)
    - routes/api/jobs.ts (retry rejects bitbucket rows)
tech_stack:
  added: []
  patterns:
    - pg_constraint existence-guarded ALTER (003/004 precedent)
    - information_schema existence-guarded DROP NOT NULL (REV-M-3)
    - DEFENSE-IN-DEPTH: bitbucket branch binds NULL installation_id even when caller passes ''
    - DEFENSE-IN-DEPTH: insertJob bypasses getOrCreateRepository when repositoryId supplied
    - PROVIDER-AWARE widening: default 'github' keeps no-arg call sites byte-identical
key_files:
  created:
    - db/migrations/005_bitbucket_repo_identity.sql
    - test/migration-005-idempotency.spec.ts
    - test/bitbucket-identity.spec.ts
    - test/repositories-provider-bypass.spec.ts
    - test/jobs-provider-filter.spec.ts
  modified:
    - src/server/db/repositories.ts
    - src/server/db/jobs.ts
    - src/server/db/webhook-deliveries.ts
    - src/shared/schema.ts
    - src/server/core/job-recovery.ts
    - src/server/services/vcs.ts
    - src/server/routes/api/jobs.ts
decisions:
  - "REV-M-3: PostgreSQL has no IF NOT NULL for DROP NOT NULL -- use DO $$ ... information_schema-guard"
  - "REV-R-C: owner=workspace_slug convention documented in migration 005 so dual-filter queries match"
  - "REV-R-B: bitbucket branch of getOrCreateRepository binds NULL for installation_id even when caller passes ''"
  - "D-02 byte-identity: default vcsProvider='github' keeps no-arg call sites byte-identical"
  - "REV-C-1: insertJob bypasses getOrCreateRepository when repositoryId supplied (defense-in-depth)"
  - "REV-C-3: jobSummarySchema.installationId nullable; mapJob returns installationId: null for Bitbucket rows"
  - "REV-R-D: recordWebhookDelivery accepts repositoryId?: number | null to attribute Bitbucket deliveries"
  - "R-01: JobRow + mapJob + jobSummarySchema expose repositoryVcsProvider + repositoryWorkspace"
metrics:
  duration: ~75 minutes
  completed_date: 2026-07-13
  tasks: 3
  files_created: 5
  files_modified: 7
status: complete
---

# Phase 5 Plan 1: Wave 0 DB foundation summary

Lays the Wave 0 foundation that closes the Phase-3 deferred item (insert/dedup/supersede provider-aware) and unblocks the Wave 2 VcsService branch point. Three tasks: idempotent migration 005 + DB module extensions + five RED tests.

## What shipped

- **Migration 005** (`db/migrations/005_bitbucket_repo_identity.sql`): makes `repositories.installation_id` nullable (REV-M-3 DO $$ information_schema-guard), adds `workspace TEXT NULL`, adds the Bitbucket-identity UNIQUE constraint `repositories_vcs_provider_workspace_repo_key`, adds a non-unique lookup index `idx_repositories_workspace_repo`. Documentation block records the REV-R-C `owner=workspace_slug` convention.
- **`findRepositoryByBitbucketIdentity`**: parameterized D-03 lookup keyed on (vcs_provider, workspace, repo). Never string-interpolates.
- **`getOrCreateRepository` provider branching** (REV-C-1): bitbucket branch uses `ON CONFLICT (vcs_provider, workspace, repo)` and binds NULL for installation_id (REV-R-B defense-in-depth -- even when caller passes `installationId: ''`). GitHub branch stays byte-identical.
- **`insertJob` widening** (REV-C-1 / REV-R-B): accepts `repositoryId?: number`, `vcsProvider?: string`, `workspace?: string | null`. When `repositoryId` is supplied, `getOrCreateRepository` is BYPASSED entirely. The GitHub call sites (no `repositoryId`, no `vcsProvider`) take the existing getOrCreateRepository path byte-identically.
- **`findExistingJobForHead` vcsProvider-aware** (D-02): optional `vcsProvider` parameter (default 'github') adds `r.vcs_provider = $X` to the WHERE. No-arg path produces byte-identical SQL (the default resolves to 'github' with the same WHERE structure as today, plus the explicit `r.vcs_provider='github'` filter which is a logical no-op on a 'github'-only DB).
- **`supersedeOlderJobs` provider branching** (REV-C-4): widened input to `{ installationId?, workspace?, owner, repo, prNumber, newJobId, vcsProvider? }`. Bitbucket branch reads `r.workspace`; GitHub branch reads `r.installation_id` (byte-identical when caller supplies installationId).
- **`mostRecentJobForPullRequest`** (D-04): returns the most recent `JobRow` for a (vcsProvider, workspace, owner, repo, prNumber) tuple. Used by the Bitbucket webhook route's `pullrequest:updated` commit-hash dedup.
- **`updateJobStatusCheckRef`** (REV-R-E): single writer of `jobs.status_check_ref`. Plan 03's `runPreparePhase` uses it instead of `Number(ref)` to `check_run_id`.
- **`recordWebhookDelivery` repositoryId passthrough** (REV-R-D): when caller supplies `repositoryId`, the function uses it directly without the owner/repo lookup. Bitbucket route passes the resolved id so the delivery is attributed to the correct Bitbucket row (no more permanent orphan).
- **JobRow widening** (R-01): every JobRow now carries `repositoryVcsProvider`, `repositoryWorkspace`, and `status_check_ref`. Every JobRow-returning SELECT grew `r.vcs_provider, r.workspace, j.status_check_ref` columns. `mapJob` surfaces all three on the JobSummary.
- **`jobSummarySchema` widening** (REV-C-3 + R-01 + REV-R-E): `installationId` becomes `z.string().nullable().optional()`; new optional fields `repositoryVcsProvider`, `repositoryWorkspace`, `statusCheckRef`. All optional so pre-widening fixtures still parse -- the GitHub call chain stays byte-identical.

## TDD Gate Compliance

| Gate | Commit | Status |
|------|--------|--------|
| RED (Task 1: migration-005-idempotency) | bbcaf29 | PASS |
| RED (Task 2: bitbucket-identity + provider-bypass) | 27b4051 | PASS |
| GREEN (Task 2: migration + repositories module) | 27b4051 | PASS |
| RED (Task 3: jobs-provider-filter) | d02d2f1 | PASS |
| GREEN (Task 3: jobs/webhook-deliveries/schema) | d02d2f1 | PASS |

All gates closed. The 4 new spec files + the existing 003/004 precedent pattern hold the migration's re-run safety invariant.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Reconstructed broken supersedeOlderJobs section after partial Edit**

- **Found during:** Task 3 (jobs.ts widening)
- **Issue:** An Edit operation that inserted the new `updateJobStatusCheckRef` / `mostRecentJobForPullRequest` functions at the start of the broken-block accidentally nested them inside `supersedeOlderJobs`'s body, leaving the file syntactically invalid (incomplete `[..., input.workspace ?? '', input.owner,` at the end of `supersedeOlderJobs`).
- **Fix:** Reconstructed the entire supersedeOlderJobs function as a single self-contained branch with both the bitbucket and github query paths; placed `mostRecentJobForPullRequest` and `updateJobStatusCheckRef` as standalone functions before `supersedeOlderJobs`. The github branch's byte-identity guarantee is preserved: when caller passes `installationId`, the SQL is identical to today's.
- **Files modified:** src/server/db/jobs.ts
- **Commit:** d02d2f1

**2. [Rule 3 - Blocking] Widened VcsService.forRepo to accept nullable installationId**

- **Found during:** Task 3 (typecheck after JobRow.installation_id widening)
- **Issue:** Plan called for R-01 widening of JobRow/mapJob to surface `repositoryVcsProvider` + `repositoryWorkspace`, which made `installationId` nullable on the row. The downstream `VcsService.forRepo` signature `{ installationId: string }` then failed typecheck for the existing `runReviewJob` call site.
- **Fix:** Widened the parameter type to `{ installationId?: string | null }` and pass `job.installationId ?? ''` defensively to the GitHubAdapter constructor. Wave 2's Bitbucket adapter implementation will replace this defensive pass-through with a real branch.
- **Files modified:** src/server/services/vcs.ts
- **Commit:** d02d2f1

**3. [Rule 3 - Blocking] Added early-skip for non-GitHub rows in check-run completion sweep**

- **Found during:** Task 3 (typecheck after JobRow.installation_id widening)
- **Issue:** `src/server/core/job-recovery.ts:43` constructed `new GitHubService(env, job.installation_id)` where `installation_id` is now nullable. A Bitbucket row (null installation_id, possibly check_run_id set by future flow) would crash at runtime.
- **Fix:** Added an early `if (!job.installation_id) continue;` guard. The check-run sweep is GitHub-only; Bitbucket flows reflect status via Code Insights / PR comment, not check_run_id.
- **Files modified:** src/server/core/job-recovery.ts
- **Commit:** d02d2f1

**4. [Rule 3 - Blocking] Retry path rejects Bitbucket rows with 400**

- **Found during:** Task 3 (typecheck after JobSummary.installationId widening)
- **Issue:** `src/server/routes/api/jobs.ts` retry path passed `source.installationId` (now nullable) into `loadRepoConfig` / `insertJob` / `supersedeOlderJobs`. The retry flow is GitHub-only today; Bitbucket retry UX lands in Wave 2.
- **Fix:** Added `if (source.installationId == null) return c.json({ error: 'Retry is not yet supported for Bitbucket jobs.' }, 400);` so the existing GitHub API surface stays byte-identical for the no-bitbucket case.
- **Files modified:** src/server/routes/api/jobs.ts
- **Commit:** d02d2f1

**5. [Rule 1 - Bug] insertJob installationId widened to `string | null` for the Bitbucket path**

- **Found during:** Task 3 (typecheck after JobSummary widening)
- **Issue:** The plan widens insertJob to accept `repositoryId?: number` (Bitbucket path) which bypasses getOrCreateRepository. But the existing `installationId: string` requirement forced Bitbucket callers to pass a non-null string, contradicting the widening intent.
- **Fix:** Widened `installationId` to `string | null`. The GitHub path always passes a string (byte-identity preserved); the Bitbucket path passes `null` plus `repositoryId`. The function's internal fallback `input.installationId ?? ''` matches the bitbucket branch's NULL-binding behavior at getOrCreateRepository.
- **Files modified:** src/server/db/jobs.ts
- **Commit:** d02d2f1

## Verification

- `npm run typecheck` PASS
- 4 new spec files GREEN: `test/migration-005-idempotency.spec.ts`, `test/bitbucket-identity.spec.ts`, `test/repositories-provider-bypass.spec.ts`, `test/jobs-provider-filter.spec.ts`
- 4 NREG-02 protected specs UNMODIFIED + GREEN: `test/webhook-handling.spec.ts`, `test/vcs-regression.spec.ts`, `test/pr-review-pipeline.spec.ts`, `test/webhook-ingest.spec.ts` (git diff --stat empty for each)
- Full node test suite PASS (260 tests)

## Self-Check

- [PASS] `db/migrations/005_bitbucket_repo_identity.sql` exists
- [PASS] `test/migration-005-idempotency.spec.ts` exists
- [PASS] `test/bitbucket-identity.spec.ts` exists
- [PASS] `test/repositories-provider-bypass.spec.ts` exists
- [PASS] `test/jobs-provider-filter.spec.ts` exists
- [PASS] `bbcaf29` commit (Task 1 RED) in `git log`
- [PASS] `27b4051` commit (Task 2 GREEN) in `git log`
- [PASS] `d02d2f1` commit (Task 3 GREEN) in `git log`
- [PASS] `npm run typecheck` returns 0
- [PASS] All four NREG-02 specs unchanged
- [PASS] All four new spec files GREEN
- [PASS] Full node test suite: 260 PASS / 0 FAIL