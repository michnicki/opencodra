---
phase: 05-bitbucket-adapter-webhook-route
plan: 02
subsystem: vcs-integration
tags: [bitbucket, zod, hmac, fetch, retry, webhooks, tdd]

requires:
  - phase: 05-bitbucket-adapter-webhook-route
    plan: 01
    provides: provider-aware repository/job schema foundation and Bitbucket identity accessors
provides:
  - Contract-first Bitbucket webhook, comment, Code Insights, and build-status schemas
  - Hand-rolled Bearer-authenticated Bitbucket Cloud REST client with bounded retries
  - Provider-neutral raw-body HMAC verifier with a backward-compatible GitHub shim
affects: [05-03-bitbucket-adapter, 05-04-bitbucket-webhook-route, vcs, webhook-security]

tech-stack:
  added: []
  patterns:
    - Workers-native fetch client with typed request contracts and bounded retry envelope
    - Inbound webhook projection preserves provider fields while outbound API payloads stay strict
    - Legacy provider shim delegates to provider-neutral HMAC primitive

key-files:
  created:
    - src/shared/bitbucket.ts
    - src/server/bitbucket/constants.ts
    - src/server/core/bitbucket.ts
    - test/bitbucket-fetch-mock.ts
    - test/bitbucket-client.spec.ts
    - test/bitbucket-schema.spec.ts
    - test/verify.spec.ts
  modified:
    - src/server/core/verify.ts

key-decisions:
  - "Atlassian's official OpenAPI confirms REPORT_TYPE='BUG'; Codra intentionally emits terminal PASSED/FAILED report results only."
  - "LINE_TYPES is an internal adapter contract: the client maps added/context to inline.to and removed to inline.from instead of sending an undocumented line_type wire field."
  - "Webhook schemas validate Codra's required projection but preserve documented extra provider fields; outbound comments/reports/statuses remain strict."
  - "Marker and summary comments use the same postPullRequestComment method with content-only payloads; inline anchors are optional as a complete union variant, never partially populated."

patterns-established:
  - "Bitbucket client errors retain raw response bodies for classification but error messages and retry logs do not interpolate those bodies."
  - "Retry-After accepts both numeric seconds and HTTP dates, falling back to exponential backoff with at most two retries."

requirements-completed: [BB-01, BB-02, BB-03, BB-05, NREG-02]

coverage:
  - id: D1
    description: "Contract-first Bitbucket webhook and outbound API schemas with shared enum constants"
    requirement: BB-02
    verification:
      - kind: unit
        ref: "test/bitbucket-schema.spec.ts (23 tests in full suite)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Hand-rolled Bitbucket REST client covering PR metadata/diff, comments, approval, Code Insights, and build status"
    requirement: BB-01
    verification:
      - kind: integration
        ref: "test/bitbucket-client.spec.ts (14 tests through fetch boundary)"
        status: pass
      - kind: integration
        ref: "npm test (35 files, 300 tests)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Provider-neutral HMAC-SHA256 verifier with byte-compatible GitHub shim"
    requirement: BB-03
    verification:
      - kind: unit
        ref: "test/verify.spec.ts (4 tests)"
        status: pass
      - kind: other
        ref: "git diff 67950674..HEAD -- src/server/routes/webhook.ts (empty)"
        status: pass
    human_judgment: false

# Metrics
duration: 20min
completed: 2026-07-13
status: complete
---

# Phase 5 Plan 2: Bitbucket Client, Contracts, and Webhook Verification Summary

**Bitbucket Cloud REST contracts and a Bearer-authenticated fetch client now cover seven review operations, backed by a shared raw-body HMAC verifier that leaves the GitHub route byte-identical.**

## Performance

- **Duration:** 20 min
- **Started:** 2026-07-13T16:30:03Z
- **Completed:** 2026-07-13T16:49:45Z
- **Tasks:** 5
- **Files modified:** 8

## Accomplishments

- Added Zod contracts for injected-event Bitbucket webhooks, native comments, Code Insights reports, and build statuses, with one constants module controlling emitted enum values.
- Added a Workers-native `BitbucketClient` for PR metadata/diffs, comment listing/posting, approvals, Code Insights report upserts, and merge-gating build statuses, all using Bearer authentication and tracked subrequests.
- Generalized webhook HMAC-SHA256 verification while preserving `verifyGitHubWebhookSignature(secret, headerValue, rawBody)` and the existing GitHub route unchanged.
- Added 40 focused tests across the three new specs and retained a green full suite of 300 tests.

## Task Commits

TDD tasks produced separate RED and GREEN commits:

1. **Task 1 RED: Generalized verifier contract** - `f933533` (`test`)
2. **Task 2 GREEN: Shared verifier and GitHub shim** - `1985402` (`feat`)
3. **Task 3 RED: Bitbucket Zod contracts** - `3825fdf` (`test`)
4. **Task 3 GREEN: Schemas and enum constants** - `8bbf49f` (`feat`)
5. **Task 4 RED: Bitbucket client and fetch-boundary harness** - `642e481` (`test`)
6. **Task 5 GREEN: Hand-rolled Bitbucket REST client** - `ac4db5c` (`feat`)
7. **Task 5 correctness follow-up: Real payloads and top-level comments** - `334f595` (`fix`)

## Files Created/Modified

- `src/shared/bitbucket.ts` - Inbound webhook projection plus strict outbound comment/report/status contracts.
- `src/server/bitbucket/constants.ts` - Single source for report, result, line classification, and build-state values Codra emits.
- `src/server/core/bitbucket.ts` - Hand-rolled Bitbucket Cloud v2 client, error type, retry envelope, and seven public methods.
- `src/server/core/verify.ts` - Provider-neutral HMAC verifier and legacy GitHub shim.
- `test/bitbucket-fetch-mock.ts` - Endpoint-recording Bitbucket fetch harness with scripted retry responses.
- `test/bitbucket-client.spec.ts` - Client methods, auth, mappings, tracker, and retry coverage.
- `test/bitbucket-schema.spec.ts` - Webhook, comment, report, build-status, and realistic-payload coverage; rewrites the pre-existing main-checkout stub rather than adding a parallel file.
- `test/verify.spec.ts` - Correct/tampered/missing-signature coverage and explicit GitHub-shim equality assertions.

## Decisions Made

- Used the official Atlassian OpenAPI (`https://dac-static.atlassian.com/cloud/bitbucket/swagger.v3.json`) as implementation-time validation after the Context7 CLI was unavailable. It confirms `BUG` as a valid Code Insights report type.
- Kept Code Insights results narrowed to Codra's terminal `PASSED | FAILED` subset even though the upstream API also supports `PENDING`; this phase never emits a pending report.
- Treated `LINE_TYPES` as an internal classification, not a REST enum. The official comment schema documents only `path`, `to`, `from`, `start_to`, and `start_from` for inline anchors.
- Preserved unconsumed fields in inbound webhook objects because Bitbucket sends full resource objects, while keeping all Codra-authored outbound payloads strict.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Corrected inline-comment wire fields against the official OpenAPI**
- **Found during:** Task 4/5 documentation validation
- **Issue:** The plan required sending `inline.line_type`, but Atlassian's official schema does not accept that field; it uses `to` for new-side lines and `from` for old-side lines.
- **Fix:** Kept `line_type` in the internal `PrComment` contract and mapped it to `inline.to` or `inline.from` in the client without sending undocumented casing.
- **Files modified:** `src/server/core/bitbucket.ts`, `test/bitbucket-client.spec.ts`, `src/server/bitbucket/constants.ts`
- **Verification:** Added/removed line tests assert exact wire payloads; full suite passes.
- **Committed in:** `642e481`, `ac4db5c`

**2. [Rule 1 - Bug] Accepted real Bitbucket webhook payload supersets**
- **Found during:** Final correctness review after Task 5
- **Issue:** Strict objects at every inbound nesting level rejected documented fields such as `actor`, `links`, repository name, and PR description, so a real webhook could never reach the route's required projection.
- **Fix:** Inbound webhook schemas now validate required fields while preserving additional provider fields; outbound schemas remain strict.
- **Files modified:** `src/shared/bitbucket.ts`, `test/bitbucket-schema.spec.ts`
- **Verification:** The new realistic-payload test failed before the fix and passes afterward.
- **Committed in:** `334f595`

**3. [Rule 2 - Missing Critical] Supported non-inline marker and summary comments**
- **Found during:** Final correctness review against Plan 03's adapter sequence
- **Issue:** `PrComment` required `path`, `line`, and `line_type`, preventing the marker and summary comments required for retry idempotency and review output.
- **Fix:** Modeled comments as a strict union of content-only or fully anchored inline variants; the client omits `inline` entirely for content-only posts.
- **Files modified:** `src/shared/bitbucket.ts`, `src/server/core/bitbucket.ts`, `test/bitbucket-client.spec.ts`
- **Verification:** The content-only comment test failed with `inline: {}` before the fix and passes with an exact content-only wire body afterward.
- **Committed in:** `334f595`

---

**Total deviations:** 3 auto-fixed (2 Rule 1 bugs, 1 Rule 2 missing critical functionality)
**Impact on plan:** All changes are required for Bitbucket API correctness or the already-locked adapter sequence; no feature scope was added.

## Issues Encountered

- `npm run typecheck` remains blocked by a pre-existing error in `test/jobs-provider-filter.spec.ts:439`: `Cannot find name 'AppBindings'`. That file is unchanged by this plan and the error exists at the expected base, so it was left for the owning Wave 0 work rather than edited out of scope.
- Context7 was not installed in the environment. The official Atlassian OpenAPI was downloaded directly and inspected instead; no package was installed.

## TDD Gate Compliance

| Feature | RED | GREEN | Status |
|---|---|---|---|
| Shared webhook verifier | `f933533` | `1985402` | PASS |
| Bitbucket API schemas | `3825fdf` | `8bbf49f` | PASS |
| Bitbucket REST client | `642e481` | `ac4db5c` | PASS |
| Real payload/top-level comments | observed failing tests | `334f595` | PASS |

## Verification

- `npm test` - PASS: 35 files, 300 tests.
- New plan specs - PASS: 3 files, 40 tests.
- Protected GitHub specs - PASS: `test/webhook-handling.spec.ts`, `test/vcs-regression.spec.ts`, `test/pr-review-pipeline.spec.ts`.
- Protected GitHub source/spec diff - PASS: all four files are byte-identical to base `67950674b56bfdf0180e2932b4b1fe196300374a`.
- `git diff --check 67950674..HEAD` - PASS.
- `npm run typecheck` - BLOCKED by the pre-existing `AppBindings` error noted above; no plan-owned TypeScript error was reported.

## Known Stubs

None. Stub-pattern scan found no placeholders, TODO/FIXME markers, or empty data sources in files created or modified by this plan.

## User Setup Required

None - no external service configuration or package installation is required for this Wave 1 foundation.

## Next Phase Readiness

- Ready for Plan 03's `BitbucketAdapter` to construct `BitbucketClient`, map provider-neutral review inputs into these request contracts, and reuse content-only comments for marker/summary posts.
- Ready for the webhook route plan to parse `{ eventName: xEventKey, ...parsedBody }` and call `verifyWebhookSignature` with `x-hub-signature`.
- The pre-existing `AppBindings` test type error should be corrected by the owning Wave 0 change before a phase-wide typecheck gate is considered fully green.

## Self-Check: PASSED

- All eight created/modified implementation and test files exist.
- All seven task/deviation commits exist in git history.
- Full test suite and focused plan specs pass with zero failures.
- Summary records the sole out-of-scope typecheck blocker without claiming a green typecheck.

---
*Phase: 05-bitbucket-adapter-webhook-route*
*Completed: 2026-07-13*
