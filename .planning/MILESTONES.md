# Milestones

## v1.0 Bitbucket Cloud Support (Shipped: 2026-07-14)

**Delivered:** Bitbucket Cloud PRs now receive the same automated AI review — inline findings, Code Insights report, build status — that GitHub PRs already get, from one Codra instance, with zero GitHub regression.

**Phases completed:** 6 phases, 19 plans, 43 tasks
**Git range:** `0ae4f61`..`8552cbc` (83 commits, 88 files changed, +10,928/-304 lines)
**Timeline:** 2026-07-12 → 2026-07-14 (2 days)
**Verification:** 22/22 v1 requirements satisfied, 6/6 phases independently verified `passed`, full milestone audit passed with zero gaps (`.planning/milestones/v1.0-MILESTONE-AUDIT.md`)

**Key accomplishments:**

- Additive schema migration (`repositories.vcs_provider`, `jobs.status_check_ref`/`review_ref`) with zero risk to existing GitHub rows, verified by an old-fixture-replay test (Phase 1)
- GitHub's review pipeline re-pointed through a new `VcsProvider` interface and `VcsService` branch point with zero behavior change, gated by a regression net written before the refactor (Phase 2)
- Webhook dedup/insert/supersede/enqueue logic extracted into a shared, provider-agnostic `core/webhook-ingest.ts`, reused byte-identical by both providers (Phase 3)
- Bitbucket bot authentication via AES-GCM encrypted Repository/Workspace Access Tokens (mirroring `core/llm-crypto.ts`), with a 4-state credential status panel in the dashboard (Phase 4)
- Full Bitbucket Cloud adapter shipped end-to-end: hand-rolled REST client, signature-verified webhook route, diff fetch respecting Bitbucket's 200-file/8,000-line caps, inline findings, Code Insights report, and build status (Phase 5)
- Bitbucket OAuth dashboard login and a provider-aware "add repo" onboarding flow, at parity with the existing GitHub UX (Phase 6)

**Known tech debt (non-blocking):** see `.planning/PROJECT.md` Context section and `.planning/milestones/v1.0-MILESTONE-AUDIT.md` for the full itemized list (cosmetic vitest hoisting warning, unreachable fail-open edge case, missing Phase 5 Nyquist validation, SUMMARY.md frontmatter gaps).

---
