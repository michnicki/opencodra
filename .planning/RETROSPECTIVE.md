# Project Retrospective

*A living document updated after each milestone. Lessons feed forward into future planning.*

## Milestone: v1.0 — Bitbucket Cloud Support

**Shipped:** 2026-07-14
**Phases:** 6 | **Plans:** 19 | **Timeline:** 2026-07-12 → 2026-07-14 (2 days)

### What Was Built
- Additive schema foundation (`vcs_provider`, provider-agnostic job reference columns) with zero risk to existing GitHub rows
- A `VcsProvider` interface + `VcsService` branch point carrying GitHub's existing pipeline with zero behavior change
- A shared, provider-agnostic webhook ingestion module (`core/webhook-ingest.ts`) reused byte-identical by both providers
- Encrypted (AES-GCM) Bitbucket bot credential storage with a 4-state dashboard status panel
- A full Bitbucket Cloud adapter: REST client, signature-verified webhook route, diff fetch, inline findings, Code Insights report, build status
- Bitbucket OAuth dashboard login and a provider-aware "add repo" onboarding flow

### What Worked
- **Regression-net-before-refactor** (Phase 2): writing tests that pin GitHub's lease/heartbeat, `forceFreshInstance`, and supersede-on-new-push invariants *before* touching `core/review.ts` made the `VcsService` flip land the same day with zero incidents — the same tests stayed green through and after the change.
- **Extract-before-second-caller** (Phase 3): pulling webhook dedup/insert/supersede/enqueue into `core/webhook-ingest.ts` while GitHub was still the only caller avoided any risk of the two providers' ingestion logic silently diverging.
- **Reuse over invention**: Bitbucket credential encryption reused `core/llm-crypto.ts`'s AES-GCM pattern instead of a new one; `core/bitbucket.ts` mirrored `core/github.ts`'s hand-rolled-REST-client shape. Both meant less new surface to get wrong.
- **NREG-02 held continuously**: every phase's own success criteria plus a final milestone-audit re-run (387/387 tests, clean typecheck) confirm GitHub's behavior never regressed across the whole milestone.
- **Wave-gated TDD** (Phases 4 and 6 Wave 0): RED test scaffolds for the whole phase's contracts were written and confirmed failing before any implementation wave began.

### What Was Inefficient
- RED-phase test scaffolds themselves contained bugs that had to be fixed before they could correctly gate implementation: a missing `repository.name` field (05-04), a sentinel-value collision (06-04), and a BitbucketAdapter test that silently skipped assertions because a diff cache wasn't seeded (05-03). Each cost a debugging cycle before the "real" implementation work could start.
- Two mid-implementation Edit/reconstruction incidents (`supersedeOlderJobs` section broken by a partial edit in 05-01; a stale orphaned `vcs_credentials` table left in the test DB in 04-03) required a follow-up fix-and-verify pass rather than landing clean the first time.
- A real `queryTransaction` atomicity bug was found and fixed during Phase 6 (06-04) — the transaction client wasn't being installed into `AsyncLocalStorage`, so "atomic" transactions weren't actually atomic until fixed.

### Patterns Established
- Provider branch point: `VcsService.forRepo`/`forProvider` as the single dispatch point for all VCS operations — future providers plug in here, not by threading conditionals through `core/review.ts`.
- Discriminated-union session types (`DashboardSessionUser`) for multi-provider dashboard auth, with a JSON allow-list parser (`parseAllowedUsersByProvider`) that falls back to the legacy single-provider format.
- Encrypt-at-boundary, never-return-ciphertext as the standard shape for any new secret-storage REST API (mirrored from `routes/api/models.ts` for `/api/vcs-credentials`).
- KV keys that need to vary by provider get a `${provider}:${id}` prefix (D-29) rather than a schema migration, accepting that pre-existing keys under the old format silently orphan.

### Key Lessons
1. Pin existing invariants with regression tests *before* refactoring shared infrastructure that a second consumer will depend on — it turns a risky flip into a same-day, zero-incident change (Phase 2).
2. Extract shared logic before the second caller exists, not after both callers are written and need reconciling — avoids divergence risk entirely (Phase 3).
3. TDD RED scaffolds need their own scrutiny — a RED test with a bug (missing field, bad sentinel, unseeded cache) can look like a passing gate for the wrong reason. Budget time to sanity-check the test itself, not just watch it fail red.
4. When a new capability needs a pattern the codebase already solved well (encryption, hand-rolled REST client, credential status API shape), copy that pattern rather than design a new one — it was consistently the fastest and safest path this milestone.

### Cost Observations
- Model mix and per-session token cost were not tracked in this milestone's phase artifacts (STATE.md's performance-metrics table has empty duration fields) — instrument this for the next milestone if cost tracking matters.
- Notable efficiency signal: 83 commits / 19 plans over 2 calendar days for a milestone touching schema, a provider abstraction, a new REST client, encrypted credential storage, and two new UI flows, with zero GitHub regressions at any point.

---

## Cross-Milestone Trends

### Process Evolution

| Milestone | Sessions | Phases | Key Change |
|-----------|----------|--------|------------|
| v1.0 | not tracked | 6 | First multi-provider milestone; established regression-net-before-refactor and extract-before-second-caller as house patterns for provider-abstraction work |

### Cumulative Quality

| Milestone | Tests | Coverage | Zero-Dep Additions |
|-----------|-------|----------|--------------------|
| v1.0 | 387 (node) + 47 (browser) | not tracked | 0 (no new npm dependencies — hand-rolled REST client and existing crypto pattern reused per constraint) |

### Top Lessons (Verified Across Milestones)

1. Regression-net-before-refactor and extract-before-second-caller (v1.0) — not yet cross-validated by a second milestone.
