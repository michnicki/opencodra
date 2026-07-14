---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
current_phase: 0
status: Awaiting next milestone
stopped_at: Completed 06-03-PLAN.md (OAuth consumer + login UI)
last_updated: "2026-07-14T09:05:05.368Z"
last_activity: 2026-07-14
last_activity_desc: Milestone v1.0 completed and archived
progress:
  total_phases: 6
  completed_phases: 6
  total_plans: 19
  completed_plans: 19
  percent: 100
current_phase_name: bitbucket-dashboard-login-repo-onboarding-ux
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-07-12)

**Core value:** A Bitbucket Cloud PR receives the same automated AI review (inline findings posted back) that a GitHub PR already gets, from one Codra instance, without breaking existing GitHub support.
**Current focus:** Phase 06 — bitbucket-dashboard-login-repo-onboarding-ux

## Current Position

Phase: Milestone v1.0 complete
Plan: —
Status: Awaiting next milestone
Last activity: 2026-07-14 — Milestone v1.0 completed and archived

## Performance Metrics

**Velocity:**

- Total plans completed: 15
- Average duration: - min
- Total execution time: 0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 01 | 2 | - | - |
| 02 | 3 | - | - |
| 03 | 1 | - | - |
| 04 | 5 | - | - |
| 06 | 4 | - | - |

**Recent Trend:**

- Last 5 plans: none yet
- Trend: -

*Updated after each plan completion*
| Phase 01 P01 | 25min | 3 tasks | 3 files |
| Phase 01 P02 | 15min | 2 tasks | 2 files |
| Phase 02 P01 | 15min | 2 tasks | 1 files |
| Phase 02 P02 | 20 min | 3 tasks | 3 files |
| Phase 02 P03 | 21 min | 2 tasks | 4 files |
| Phase 03 P01 | 15min | 2 tasks | 3 files |
| Phase 06 P01 | 25min | 4 tasks | 5 files |
| Phase 06 P02 | 35min | 3 tasks | 14 files |
| Phase 06 P03 | 30min | 2 tasks | 6 files |
| Phase 06 P04 | 55min | 3 tasks | 12 files |

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- [Phase 06 planning]: D-29 storage resolution -- updates-email lives in APP_KV (NOT a SQL table); Wave 1 plan changes the KV key format from `updates-email:${githubUserId}` to `updates-email:${provider}:${id}`. NO 006_*.sql migration is written (per 06-RESEARCH.md §A + Pitfall 4); orphaned old keys are harmless (users re-subscribe on next login per 06-RESEARCH.md §E).
- [Phase 06 planning]: Phase 6 ships 4 plans in 4 waves: Wave 0 (5 RED specs: test/discriminated-session, test/parse-allowed-users-by-provider, test/bitbucket-oauth, test/add-bitbucket-repo, test/auth-allow-list); Wave 1 (Foundation: D-26 union + D-27 parser + D-29 KV-key + D-36/37 secrets/var + AppBindings widening + cf-typegen); Wave 2 (OAuth consumer + login UI: core/bitbucket-oauth + auth-bitbucket router + BitbucketMark + login page rework); Wave 3 (Add-Repo Flow: getOrCreateBitbucketRepository + transactional POST /api/repos/bitbucket + DropdownMenu on /repos + /repos/add/bitbucket SPA page + addBitbucketRepo typed wrapper + app-shell union handling).
- [Phase 06 planning]: NREG-02 cross-cutting gate -- 13 protected specs stay UNMODIFIED + green: test/webhook-handling, test/vcs-regression, test/pr-review-pipeline, test/review-flow, test/review-resilience, test/workflow-finalize-fresh-instance, test/async-batch-review, test/review-subrequest-completion, test/vcs-credentials, test/bitbucket-client, test/bitbucket-adapter, test/bitbucket-webhook, test/api.
- [Phase 06 planning]: Zero new infrastructure per hard constraint -- no new npm packages, no new tables, no new Cloudflare bindings; Phase 6 is pure glue over Phases 1-5.
- [Phase 06 planning]: Contract-first per 06-CONTEXT.md §"Conventions" -- Zod schemas in src/shared/schema.ts / src/shared/bitbucket.ts BEFORE UI / route handlers / core files use them (Wave 1 authors bitbucketOAuthProfileSchema + addBitbucketRepoInputSchema in src/shared/bitbucket.ts).
- Research: Bot auth uses Repository/Workspace Access Tokens (Bearer), not Atlassian Connect or app passwords; dashboard login uses a separate OAuth 2.0 consumer — the two credentials are never conflated.
- Research: GitHub's pipeline is wrapped (not rewritten) behind a `VcsProvider` interface, mirroring the existing `ModelService`/`models/types.ts` strategy pattern; the state machine (lease/heartbeat/supersede) stays unmoved.
- Research: Bitbucket's `{path, to, from}` comment anchor has no `commit_id` equivalent — the shared comment contract is built around path + line, not a GitHub-style commit-anchored model.
- [Phase 01]: Confirmed live via pg_constraint that repositories' legacy unique constraint is named repositories_owner_repo_key; new constraint repositories_vcs_provider_owner_repo_key added with byte-identical guard/name
- [Phase 01]: No backfill UPDATE for vcs_provider -- DEFAULT 'github' on ADD COLUMN alone populates every existing row (D-07)
- [Phase 01]: Only src/server/db/repositories.ts touched for getOrCreateRepository provider-awareness; jobs.ts and repo-configs.ts call sites untouched (D-05)
- [Phase 01]: Changed ReviewJobMessage type from z.infer (output) to z.input so provider's optional+defaulted field doesn't retroactively require it at every pre-existing queue-producer call site and test fixture
- [Phase 02]: Regression net (test/vcs-regression.spec.ts) pins lease-release, forceFreshInstance threading, and supersede-on-new-push against today's unmodified GitHub-only core/review.ts, before Wave 2's VcsProvider branch-point flip — NREG-01 / criterion 1: the safety net must exist and be green before the abstraction refactor lands; it must also survive the flip unmodified (criterion 4) since it mocks the same '@server/services/github' path the adapter will wrap
- [Phase 02]: Adopted the reviewed create/update status-check input split (VcsCreateStatusCheckInput requires headSha, VcsUpdateStatusCheckInput omits it) instead of a single shared input type — Review finding 6 (opencode MEDIUM) - avoids leaking an unavailable headSha into core/review.ts's four updateStatusCheck call sites
- [Phase 02]: GithubAdapter wraps GitHubService (not GitHubClient) — Preserves vi.mock('@server/services/github') interception for three existing specs while pr-review-pipeline's real-client path stays green (review finding 5)
- [Phase 02]: BOT_USERNAME injection proven via a GitHubService.prototype.findBotReviewForCommit spy — installGitHubFetchMock's review-list lookup always returns [], so it cannot prove the botLogin argument over the wire (review finding 3)
- [Phase 02]: core/review.ts flipped through VcsProvider via the new VcsService.forRepo/forProvider branch point; zero direct GitHubService/GitHubClient references remain — FND-05 — full suite (24 files/213 tests) green, all six protected pipeline specs and the Plan 01 regression spec unmodified
- [Phase 02]: failJobAndCheckRun retyped to a local CheckRunUpdater structural type with a checkRunUpdaterFor(vcs) shim at its two call sites, instead of Pick<VcsProvider,'updateStatusCheck'> — Preserves test/review-resilience.spec.ts's protected updateCheckRun numeric-id DI contract byte-identical (review finding 2)
- [Phase 02]: toReviewEvent removed from services/formatter.ts; formatter is now purely provider-agnostic, enum mapping lives only in GithubAdapter.submitReview — Review finding 1 — test/formatter.spec.ts is not a protected pipeline spec, so trimming its matching describe block is legitimate
- [Phase 03]: DEFERRED TO PHASE 5 -- webhook-ingest helper extracts provider-NEUTRAL orchestration only; insertJob/findExistingJobForHead/supersedeOlderJobs/repo-config lookup must be made provider-aware before any Bitbucket concrete job routes through it (REVIEW finding 3)
- [Phase 03]: provider key only attached to the outgoing queue message via an explicit conditional guard, never spread/default, to guarantee byte-identical GitHub-enqueued message shape (D-02)
- [Phase 05]: Repo identity -- migration 005 makes repositories.installation_id NULLABLE and adds workspace TEXT NULL plus a UNIQUE(vcs_provider, workspace, repo) Bitbucket-identity constraint; findExistingJobForHead/supersedeOlderJobs gain optional vcsProvider filter defaulting to 'github' so existing GitHub call sites are byte-identical (NREG-02)
- [Phase 05]: pullrequest:updated commit-hash dedup -- new db/jobs.ts::mostRecentJobForPullRequest(vcsProvider, workspace, owner, repo, prNumber) reuses jobs.commit_sha; no schema migration; ignores metadata-only edits by comparing to the most recent job's commit_sha
- [Phase 05]: Bitbucket submitReview sequence -- adapter POSTs a marker comment (<!-- codra:job={jobId} commit={commitSha} -->) then per-VcsReviewComment inline comments then summary then (only on verdict='approve') POST .../approve; findExistingReviewForCommit lists PR comments and filters for the marker, mirroring GitHub's findBotReviewForCommit semantics so core/review.ts finalize re-run safety is satisfied unchanged
- [Phase 05]: Comment anchor + severity icons -- adapter resolves VcsReviewComment.position -> (path, to/from line) via findPositionForLine over the parsed FileDiff (no VcsReviewComment shape change); severity icons use an emoji fallback on Bitbucket (vcs.name === 'bitbucket') because Bitbucket's Markdown renderer does not reliably render inline <img src=...> HTML in PR comments
- [Phase 05]: VcsService.forRepo branch is now potentially-rejecting -- BitbucketAdapter constructor loads + decrypts the access token via getVcsCredentialSecrets + decryptSecret; the existing lease-release try/catch in core/review.ts:388-394 wraps the call so a credential read failure cannot wedge the lease
- [Phase ?]: [Phase 06 Plan 01]: RED contracts authored for all 5 Wave 0 specs; each new spec stubs globalThis.fetch/vi.mock locally instead of modifying the shared test/bitbucket-fetch-mock.ts or test/github-fetch-mock.ts helpers (protected by NREG-02).
- [Phase ?]: [Phase 06 Plan 01]: DASH-01/DASH-02 requirement checkboxes intentionally NOT marked complete yet -- this plan is Wave 0 (RED contracts only, zero production code); they close once Waves 1-3 (06-02..06-04) land the actual implementation.
- [Phase 06 Plan 02]: authSessionUserSchema (D-26 discriminated union) defined exactly once in src/shared/api.ts; src/server/env.ts re-exports it as dashboardSessionUserSchema rather than redefining it, closing the client/server schema-drift review finding structurally.
- [Phase 06 Plan 02]: DEVIATION (Rule 3 auto-fix): added an optional `login?: string` field to the Bitbucket variant of authSessionUserSchema. Full-repo typecheck surfaced test/api.spec.ts:316 reading `data.user.login` unnarrowed on the union -- an NREG-02 protected spec that must not be edited, and a call site the plan's own audit (grep over src/server/ + src/client/ only) missed. The optional field has zero runtime effect and lets TS resolve the union access without narrowing.
- [Phase 06 Plan 02]: npm run typecheck is clean of every error this plan owns; 2 remaining tsc errors (test/bitbucket-oauth.spec.ts, test/auth-allow-list.spec.ts module-resolution) are Wave 0 RED specs explicitly targeting Wave 2's core/bitbucket-oauth.ts + routes/auth-bitbucket.ts -- not a Wave 1 regression, per 06-01-SUMMARY.md's own account.
- [Phase 06 Plan 02]: DASH-01/DASH-02 requirement checkboxes still NOT marked complete -- deferred to whichever of 06-03/06-04 lands the user-facing login/add-repo flow, consistent with 06-01's deferral rationale.
- [Phase 06 Plan 02]: DEPLOY NOTE -- the DASHBOARD_ALLOWED_USERS wrangler.jsonc var-format migration (comma-separated -> JSON) must ship in the same deploy as this plan's parseAllowedUsersByProvider code (06-REVIEWS.md MEDIUM finding).
- [Phase 06 Plan 03]: core/bitbucket-oauth.ts + routes/auth-bitbucket.ts mirror github-oauth.ts/auth.ts 1:1; createAuthBitbucketRouter mounted in app.ts alongside createAuthRouter (sibling-file pattern, resolving the Blockers/Concerns open question from Wave 0 planning).
- [Phase 06 Plan 03]: DEVIATION (Rule 1 auto-fix): BitbucketOAuthProfile.links made optional (not required as the plan's action text specified) -- a protected Wave-0 RED-spec fixture omits links entirely; toDashboardSessionUser's explicit `: DashboardSessionUser` return-type annotation removed so the protected RED spec's unnarrowed field reads (mapped.accountId/.uuid/.username/.displayName) typecheck.
- [Phase 06 Plan 03]: npm run test:browser requires `nix-shell shell.nix --run "..."` on this NixOS host (missing libgbm.so.1 for Playwright's headless Chromium in the default shell) -- a pre-existing, documented environment quirk, not a code issue.
- [Phase 06 Plan 03]: DASH-01 requirement checkbox still NOT marked complete -- deferred to 06-04, which lands the final Add-Repo Flow UI surface, consistent with 06-01/06-02's deferral rationale.
- [Phase 06]: [Phase 06 Plan 04]: queryTransaction fixed to install the tx client into AsyncLocalStorage via dbStorage.run -- nested queryRows calls inside a transaction callback now genuinely participate in the transaction; no public-signature change.
- [Phase 06]: [Phase 06 Plan 04]: DEVIATION (Rule 1 auto-fix): test/add-bitbucket-repo.spec.ts's sentinel accessToken 'tok' changed to 'zzk' -- the original value collided with the legitimate response field name tokenExpiresAt, making the never-leaks assertion fail regardless of implementation correctness.
- [Phase 06]: [Phase 06 Plan 04]: DASH-01/DASH-02 requirements now marked complete -- this is the final plan (Wave 3) of Phase 6, landing the end-to-end add-repo UX.

### Pending Todos

None yet.

### Blockers/Concerns

- Phase 2 is the highest-scrutiny phase: regression tests for lease/heartbeat/`forceFreshInstance`/supersede-on-new-push must be written and passing *before* the abstraction refactor lands (PITFALLS.md Pitfall 9).
- Phase 4's auth decision has open sub-questions to verify before detailed planning: whether one OAuth consumer can serve both dashboard-login and bot-posting, and current workspace-vs-repository access-token permission scopes (research flag).
- Phase 5 has several MEDIUM-confidence items to verify empirically before/during planning: `pullrequest:updated` new-commit semantics, Code Insights `report_type` enum values, and Bitbucket Markdown support for the `<img>`-tag severity icons used by `services/formatter.ts`.
- RESOLVED (Phase 06 Plan 03): Wave 2 used the sibling-file pattern (`routes/auth-bitbucket.ts` exporting `createAuthBitbucketRouter`, mounted alongside `createAuthRouter` in `app.ts`) — matching test/auth-allow-list.spec.ts's expected import without modification.
- Phase 6 NREG-02 risk: test/api.spec.ts fixtures may construct `DashboardSessionUser` literals without a `provider: 'github'` discriminator after Wave 1's union widening. Pre-Wave-1 review of test/api.spec.ts:319,333,337,350,355 will determine whether the resolver is (a) widening the schema's GitHub variant with `.default('github')` (preferred — no spec edits) OR (b) accepting an edit (violates NREG-02 — disallowed).

## Deferred Items

Items acknowledged and carried forward from previous milestone close:

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| v2 Differentiator | ANNO-01: Per-line Code Insights annotations | Deferred to v2 | Requirements definition, 2026-07-12 |
| v2 Differentiator | WS-01: Workspace-level token/webhook | Deferred to v2 | Requirements definition, 2026-07-12 |
| Phase 6 deferred | Bitbucket "Sync Repositories" workspace list | Deferred to a future phase | Phase 6 06-CONTEXT.md §"Deferred Ideas" |
| Phase 6 deferred | Live "validate stored token" endpoint | Deferred to a future phase | Phase 6 06-CONTEXT.md §"Deferred Ideas" |

## Session Continuity

Last session: 2026-07-14T08:20:29.256Z
Stopped at: Completed 06-03-PLAN.md (OAuth consumer + login UI)
Resume file: None

## Operator Next Steps

- Start the next milestone with /gsd-new-milestone
