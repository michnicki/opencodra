---
phase: 05-bitbucket-adapter-webhook-route
plan: 03
type: execute
subsystem: vcs
tags: [bitbucket, vcs-adapter, lease-safety, ref-opacity, provider-discriminator, nreg-02, webhook-route]
dependency_graph:
  requires:
    - 05-01
    - 05-02
  provides:
    - src/server/vcs/bitbucket.ts
    - src/server/vcs/types.ts widening (REV-M-5 + REV-M-10)
    - src/server/services/vcs.ts branches (D-14 + D-15)
    - src/server/services/formatter.ts emoji fallback (D-13)
    - src/server/core/review.ts REV-C-2 + R-02 + REV-M-7
    - src/server/core/job-recovery.ts REV-M-8 widening
    - src/server/db/jobs.ts SELECT widening (REV-M-8)
  affects:
    - src/server/core/review.ts (provider-aware ref persistence + finalize gate)
    - src/server/core/job-recovery.ts (provider-aware terminal reconciliation)
    - src/server/services/vcs.ts (forRepo + forProvider branches)
    - src/server/services/formatter.ts (severityIcon + formatInlineComment options bag)
tech-stack:
  added: []
  patterns:
    - Async static factory for credential-dependent adapters (D-14 / lease-safety)
    - REV-R-A combined marker+summary POST with inline-comment dedup-before-POST
    - REV-M-9 verdict mapping (neutral -> SUCCESSFUL, NOT INPROGRESS)
    - REV-M-10 provider-opaque ref semantics (build-status POST always uses key='codra-review')
    - Provider discriminator forwarded from review.ts to formatter (D-13)
    - Provider-aware reconciliation via VcsService.forRepo (REV-M-8)
key-files:
  created:
    - src/server/vcs/bitbucket.ts (BitbucketAdapter implements VcsProvider; async static create factory)
    - test/bitbucket-adapter.spec.ts (14 cases pinning the adapter's per-method contract)
    - test/vcs-service.spec.ts (8 cases covering Bitbucket branch + NotImplementedError)
    - test/job-recovery-provider.spec.ts (5 cases pinning REV-M-8 widening)
  modified:
    - src/server/vcs/types.ts (VcsSubmitReviewInput.jobIdHint? + updateStatusCheck ref-opacity docs)
    - src/server/vcs/github.ts (submitReview accepts jobIdHint, ignored)
    - src/server/services/vcs.ts (forRepo branches on repositoryVcsProvider; forProvider widens)
    - src/server/services/formatter.ts (severityIcon + formatInlineComment options-bag with bitbucket emoji)
    - src/server/core/review.ts (REV-C-2 prepare-phase ref handling, R-02 finalize gate widening, REV-M-7 baseSha nullable)
    - src/server/core/job-recovery.ts (REV-M-8: VcsService.forRepo reconciliation route)
    - src/server/db/jobs.ts (REV-M-8: WHERE clause + hasPendingMaintenanceWork OR widening)
decisions:
  - "BitbucketAdapter uses an async static `create(env, job, tracker)` factory (D-14): the credential read must complete before the constructor returns, and any rejection propagates to the caller's lease-release try/catch at core/review.ts:388-394 (the Phase 2 D-05 lease-safety invariant this factory was carved out to satisfy)."
  - "submitReview posts a single combined marker+summary comment at the END of the sequence (REV-R-A), with inline-comment dedup before each POST. The dedup-before-POST makes mid-sequence-crash retries idempotent: an existing matching comment is skipped, not duplicated."
  - "updateStatusCheck maps verdict='comment' (the Bitbucket equivalent of GitHub's 'neutral') to build-status 'SUCCESSFUL' (REV-M-9), NOT 'INPROGRESS'. The latter would permanently block PR merges on Bitbucket workspaces enforcing 'require passing builds' once the review finishes."
  - "updateStatusCheck's `ref` argument is PROVIDER-OPAQUE (REV-M-10): the adapter interprets it (GitHub: Number(ref) -> numeric check_run_id; Bitbucket: ref is the report_id for the Code Insights PUT only; the build-status POST always uses HARDCODED key='codra-review')."
  - "VcsService.forProvider({ provider: 'bitbucket' }) throws a typed NotImplementedError (D-15): the only Bitbucket event source is the webhook route in Wave 3 which always creates a job row before the worker needs a provider; no live Bitbucket no-job-row path is shipped this phase."
  - "ReviewRequest.baseSha widened to string | null (REV-M-7): the Bitbucket route may pass empty string OR destination.commit.hash; the insertJob call coerces null to '' to satisfy the column's non-null constraint."
  - "completeTerminalCheckRuns now routes through VcsService.forRepo (REV-M-8): a Bitbucket job's status_check_ref routes the reconciliation through BitbucketAdapter.updateStatusCheck (PUT Code Insights + POST build status); the GitHub path stays byte-identical because VcsService.forRepo returns GithubAdapter for repositoryVcsProvider='github' or null."
metrics:
  duration_seconds: 1775
  completed_date: 2026-07-13
  tasks_completed: 6
  files_modified: 7
  files_created: 4
  tests_added: 27
  tests_total_impacted: 202
status: complete
---

# Phase 5 Plan 3: BitbucketAdapter + VCS Branching — Summary

## Overview

Realized the `VcsProvider` interface for Bitbucket Cloud (D-08..D-12) so the Wave 2 branch point in `VcsService.forRepo` can dispatch a job whose repository row carries `vcs_provider='bitbucket'` to a `BitbucketAdapter` that loads + decrypts the per-repo credential. The lease-safety invariant (D-14) is realized by wrapping the credential read in the existing `core/review.ts:388-394` try/catch. The D-13 emoji-severity fallback is gated by `vcs.name === 'bitbucket'` inside `FormatterService.severityIcon`. R-02 (the Bitbucket path's status-check gate change) widens `core/review.ts:1438` to `if (job.statusCheckRef || job.checkRunId)`. REV-C-2 replaces `Number(ref)` at `core/review.ts:694-710` with `await updateJobStatusCheckRef(env, job.id, checkRun.ref)` — string ref is persisted unchanged. REV-R-A combines marker+summary into a single final comment with inline-comment dedup. REV-M-9 maps verdict='comment' to 'SUCCESSFUL' (the antigravity merge-blocking fix). REV-M-5 adds `jobIdHint?: string` to `VcsSubmitReviewInput`. REV-M-7 makes `ReviewRequest.baseSha` nullable. REV-M-8 routes `completeTerminalCheckRuns` through `VcsService.forRepo` and widens the SELECT to OR `status_check_ref IS NOT NULL`.

This is the highest-scrutiny commit for Phase 5's GitHub non-regression — the lease-release wrapper was added in Phase 2 specifically to absorb a Phase 5 credential-read rejection. R-02 widening is silent drop-in only if the numeric-id `check_run_id` GitHub path keeps working; the four protected NREG-02 specs are the gate, all of which pass UNMODIFIED.

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | RED test/bitbucket-adapter.spec.ts — pinning the adapter surface | 779cc68 | test/bitbucket-adapter.spec.ts |
| 2 | src/server/vcs/bitbucket.ts + VcsService branches + REV-M-5 + REV-M-10 | 6f58880 | src/server/vcs/bitbucket.ts (NEW), vcs/types.ts, vcs/github.ts, services/vcs.ts |
| 3 | test/vcs-service.spec.ts — bitbucket branch + credential read + NotImplementedError | 1609f23 | test/vcs-service.spec.ts (NEW) |
| 4 | services/formatter.ts severityIcon emoji fallback (D-13) + formatter test (RED + GREEN) | 9364d03 / 6603ae3 | src/server/services/formatter.ts, test/formatter.spec.ts |
| 5 | core/review.ts — REV-C-2 + R-02 + REV-M-7 | 54ccc2a | src/server/core/review.ts |
| 6 | job-recovery.ts REV-M-8 widening + types.ts widening (already done in T2) + RED test/job-recovery-provider.spec.ts | 474a8ab | src/server/core/job-recovery.ts, src/server/db/jobs.ts, test/job-recovery-provider.spec.ts (NEW) |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] BitbucketAdapter RED test: inline comments were silently skipped when the diff cache wasn't seeded**
- **Found during:** Task 1 (test/bitbucket-adapter.spec.ts RED -> GREEN)
- **Issue:** The first RED run revealed that `anchorForComment` returns null when no FileDiff walk matches the position, causing `submitReview` to silently skip inline comments. The combined marker+summary then became the FIRST POST, returning `id: 100` instead of `id: 101` from the mock's response queue. Two test cases needed to seed the KV-cached diff directly via `env.APP_KV.put(\`diff:${job.id}\`, rawDiff)` to deterministically produce valid position->line anchors.
- **Fix:** Seeded the diff cache in both tests (`submitReview posts the combined marker+summary as the FINAL comment` and `translates VcsReviewComment.position to Bitbucket inline anchor`). Also corrected the hunk header `@@ -5,1 +6,3 @@` to `@@ -5,1 +6,2 @@` (the original was inconsistent with the actual line counts of ` contextA` + `+addedB`).
- **Files modified:** test/bitbucket-adapter.spec.ts
- **Commit:** 779cc68 (initial test), 6f58880 (iterated within the implementation commit)

**2. [Rule 3 - Blocking] job-recovery-provider.spec.ts: vi.mock hoisting error blocked test execution**
- **Found during:** Task 6
- **Issue:** Initial test file used top-level `vi.fn()` references inside `vi.mock()` factory functions. Vitest hoists `vi.mock` calls above the top-level `const forRepoMock = vi.fn()` statements, so the factory couldn't see those names — vitest threw `[vitest] There was an error when mocking a module. If you are using "vi.mock" factory, make sure there are no top level variables inside, since this call is hoisted to top of the file.`
- **Fix:** Wrapped the mock fn declarations in `vi.hoisted(() => ({...}))` so the references are hoisted alongside the `vi.mock` calls. Followed the same pattern as `test/review-resilience.spec.ts`.
- **Files modified:** test/job-recovery-provider.spec.ts
- **Commit:** 474a8ab

**3. [Rule 1 - Bug] job-recovery-provider.spec.ts: regex didn't tolerate SQL comment block between OR widening tokens**
- **Found during:** Task 6
- **Issue:** The `getTerminalJobsNeedingCheckRunCompletion` SQL has a multi-line `-- REV-M-8: ...` comment block between the status predicate and the `(check_run_id IS NOT NULL OR status_check_ref IS NOT NULL)` AND clause. A naive literal regex `/check_run_id IS NOT NULL OR status_check_ref IS NOT NULL/` failed because the actual SQL is `j.check_run_id IS NOT NULL OR j.status_check_ref IS NOT NULL` (with `j.` table qualifier).
- **Fix:** Updated the regex to `(?:j\.)?check_run_id\s+IS\s+NOT\s+NULL\s+OR\s+(?:j\.)?status_check_ref\s+IS\s+NOT\s+NULL` (tolerates the `j.` qualifier and whitespace).
- **Files modified:** test/job-recovery-provider.spec.ts
- **Commit:** 474a8ab

### Plan-exact Executions

All other plan items executed exactly as written. No architectural changes were needed beyond what was specified.

## Verification Results

| Check | Result |
|-------|--------|
| test/bitbucket-adapter.spec.ts (14 tests) | PASS |
| test/vcs-service.spec.ts (8 tests) | PASS |
| test/formatter.spec.ts (31 tests, 7 new Bitbucket emoji cases + 24 existing GitHub cases) | PASS |
| test/job-recovery-provider.spec.ts (5 tests) | PASS |
| test/review-resilience.spec.ts (UNMODIFIED) | PASS (NREG-02 holds) |
| test/vcs-regression.spec.ts (UNMODIFIED) | PASS (NREG-02 holds) |
| test/webhook-handling.spec.ts (UNMODIFIED) | PASS (NREG-02 holds) |
| test/pr-review-pipeline.spec.ts (UNMODIFIED) | PASS (NREG-02 holds) |
| npm run typecheck | PASS |
| `grep -n 'if (job.checkRunId) {' src/server/core/review.ts` | 1 match (line 1022, prepare-phase guard) |
| `grep -n 'updateJobStatusCheckRef' src/server/core/review.ts` | Present (line 725) |
| `grep -n "Number(checkRun.ref)" src/server/core/review.ts` | 1 match (line 718, inside vcs.name === 'github' branch) |
| `grep -n 'new GitHubService' src/server/core/job-recovery.ts` | 0 matches in production code (only docstring comment) |
| REV-M-9: 'neutral' -> 'SUCCESSFUL' in bitbucket.ts | Present (lines 184-185) |
| REV-M-10: PROVIDER-OPAQUE ref docs in types.ts | Present (line 91) |
| REV-M-5: jobIdHint in types.ts | Present (line 71) |

## Acceptance Criteria

- [x] **D-08**: BitbucketAdapter.submitReview posts the combined marker+summary as the FINAL comment with the `<!-- codra:job={jobIdHint} commit={commitSha} -->` marker, after per-VcsReviewComment inline comments with dedup-before-POST, then `/approve` ONLY when verdict === 'approve'.
- [x] **D-09**: BitbucketAdapter.findExistingReviewForCommit lists PR comments paginated by pagelen=100 and filters for the marker prefix `<!-- codra:job=` with `commit={commitSha}` substring; returns `{ ref: '<commentId>' }` or null.
- [x] **D-10**: BitbucketAdapter.createStatusCheck PUTs `/commit/{commit}/reports/codra-review` with `report_type=REPORT_TYPE` ('BUG'), `result='PASSED'`, returns `{ ref: 'codra-review' }`.
- [x] **D-11**: BitbucketAdapter.updateStatusCheck PUTs the Code Insights report THEN POSTs `/commit/{commit}/statuses/build` with HARDCODED `key='codra-review'`. The PUT happens BEFORE the POST.
- [x] **D-12**: BitbucketAdapter.submitReview translates `VcsReviewComment.position` to Bitbucket's `{path, to/from, line_type}` anchor by walking the parsed FileDiff (from the cached diff via `diffCacheKey` + `env.APP_KV`) using the flattened hunk-line search (`line.position === comment.position`). R-03 inverse for `del` kind (`from=line.oldLineNumber, line_type='removed'`).
- [x] **D-13**: formatter.severityIcon + formatInlineComment return emoji when `provider === 'bitbucket'`; GitHub `<img>` rendering byte-identical when `provider === 'github'` (or no options).
- [x] **D-14**: VcsService.forRepo branches on `job.repositoryVcsProvider === 'bitbucket'`, constructs `BitbucketAdapter.create(env, job, tracker)` (which loads + decrypts the credential). The credential-read throw is caught by the Phase-2 lease-release wrapper at `core/review.ts:388-394`.
- [x] **D-15**: VcsService.forProvider accepts `provider: 'github' | 'bitbucket'`; the bitbucket branch throws `NotImplementedError`.
- [x] **REV-01..REV-03**: finalize path posts (a) inline comments anchored by path + line + line_type (no commit_id), (b) Code Insights report keyed by `report_id='codra-review'` so retries upsert, (c) commit build status keyed by `key='codra-review'`.
- [x] **R-02**: core/review.ts:1438 gate widened to `if (job.statusCheckRef || job.checkRunId)` so the Bitbucket finalize path reaches the cosmetic-update try/catch with its TEXT ref.
- [x] **REV-C-2**: core/review.ts lines 694-710 no longer calls `Number(checkRun.ref)` unconditionally; the Bitbucket path persists the string ref via `updateJobStatusCheckRef(env, job.id, checkRun.ref)` — no Number conversion, no throw.
- [x] **REV-M-5**: VcsSubmitReviewInput.jobIdHint?: string added; GithubAdapter.submitReview accepts it (ignored); BitbucketAdapter.submitReview uses it for the combined marker+summary comment.
- [x] **REV-M-7**: ReviewRequest.baseSha is `string | null` (Bitbucket route may pass empty string when `destination.commit.hash` is unavailable).
- [x] **REV-M-8**: completeTerminalCheckRuns routes through VcsService.forRepo; getTerminalJobsNeedingCheckRunCompletion widens the WHERE clause to OR `status_check_ref IS NOT NULL`.
- [x] **REV-M-9**: BitbucketAdapter.updateStatusCheck maps verdict 'comment' to 'SUCCESSFUL' (NOT 'INPROGRESS' — the antigravity merge-blocking bug).
- [x] **REV-M-10**: VcsProvider.updateStatusCheck JSDoc documents provider-opaque ref semantics; BitbucketAdapter.updateStatusCheck ignores the ref argument for the build-status POST.
- [x] **REV-R-A**: BitbucketAdapter.submitReview combines marker+summary into a single final post; inline-comment posts are dedup'd before each POST.
- [x] **NREG-02**: the four protected specs (review-resilience, vcs-regression, webhook-handling, pr-review-pipeline) pass UNMODIFIED. `git diff --stat` returns empty for each.

## Output Artifacts

- src/server/vcs/bitbucket.ts (NEW, 340 lines) — `BitbucketAdapter implements VcsProvider` with async static `create` factory, REV-R-A combined marker+summary, REV-M-9 verdict mapping, REV-M-10 ref-opacity, D-12 position->line anchor translation.
- src/server/vcs/types.ts (MODIFIED) — REV-M-5 jobIdHint widening; REV-M-10 updateStatusCheck JSDoc.
- src/server/services/vcs.ts (MODIFIED) — D-14 forRepo branch on `repositoryVcsProvider`; D-15 forProvider widens to `'github' | 'bitbucket'` with `NotImplementedError` for Bitbucket.
- src/server/services/formatter.ts (MODIFIED) — D-13 emoji severityIcon gated by `provider === 'bitbucket'`; GitHub `<img>` path byte-identical.
- src/server/core/review.ts (MODIFIED) — REV-C-2 prepare-phase ref handling (provider-aware); R-02 finalize gate widening; REV-M-7 baseSha nullable; formatter call site forwards `{ provider: vcs.name }`.
- src/server/core/job-recovery.ts (MODIFIED) — REV-M-8 reconciliation routes through VcsService.forRepo.
- src/server/db/jobs.ts (MODIFIED) — REV-M-8 WHERE clause + hasPendingMaintenanceWork OR widening.
- test/bitbucket-adapter.spec.ts (NEW, 14 tests).
- test/vcs-service.spec.ts (NEW, 8 tests).
- test/job-recovery-provider.spec.ts (NEW, 5 tests).
- test/formatter.spec.ts (EXTENDED, 7 new Bitbucket emoji cases; existing GitHub `<img>` assertions UNCHANGED).

## Key Insights

1. **REV-C-2 is a single-load-bearing branch point.** Before this plan, `Number(checkRun.ref)` threw on Bitbucket's `'codra-review'` ref and would have wedged every prepare phase. The branch on `vcs.name === 'github'` is the smallest possible change — it keeps the GitHub numeric flow (with the WR-03 `Number.isFinite` guard) untouched and adds a one-line call to `updateJobStatusCheckRef` for the Bitbucket path.

2. **The lease-safety invariant is realized at exactly the seam Phase 2 carved out.** The async static `create(env, job, tracker)` factory's credential read can reject (`Bitbucket credential not configured for ${ws}/${repo}` or a decryption failure). That rejection propagates to `core/review.ts:388-394` — the try/catch that releases the lease before re-throwing. No new try/catch was added; Phase 2's preparation pays off.

3. **REV-M-10's ref-opacity is the key invariant for merge-gating.** The build-status POST must always use `key='codra-review'`, regardless of the `ref` argument. If the ref were used naively, retries that pass a fresh ref (e.g. `'something-else'`) would create a different build-status key, breaking Bitbucket's idempotent update model. The JSDoc + a hardcoded `key` constant encode this invariant in code.

4. **REV-R-A combined marker+summary is structurally different from GitHub.** GitHub posts one `createReview` call (which embeds all comments + body). Bitbucket has no such aggregation, so the marker + summary are composed into a single final PR comment (`<!-- codra:job=X commit=Y -->\n\n<sub>codra-review</sub>\n\n{summaryBody}`). The dedup-before-POST on inline comments makes retries idempotent across mid-sequence crashes — a deleted row in the dedup set within a single submitReview invocation is intentional (in case the same body would otherwise double-post on a retry within the same call).

5. **REV-M-8 widens the maintenance sweep without breaking the GitHub path.** `VcsService.forRepo(env, job, undefined)` reads `job.repositoryVcsProvider` and returns either `GithubAdapter` (numeric check_run_id path) or `BitbucketAdapter` (TEXT status_check_ref path). For repositoryVcsProvider='github' or null, the returned adapter is `GithubAdapter` and the existing numeric flow is byte-identical. The change is purely additive.

## Next Plan

Phase 5 Plan 4 (the webhook route) reads this plan's `BitbucketAdapter` via `VcsService.forRepo(env, job, tracker)` end-to-end. The Wave 3 webhook route then constructs the adapter for jobs whose repository row carries `vcs_provider='bitbucket'`.