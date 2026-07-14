# Codra — Bitbucket Cloud Support

## What This Is

Codra is self-hosted AI code review for pull requests, running entirely on Cloudflare (Workers, Queues, KV, Hyperdrive, Workers AI) with an external PostgreSQL database. It reviews pull requests on **both GitHub and Bitbucket Cloud** from a single deployed instance: a per-provider webhook enqueues review jobs, a durable Cloudflare Workflow runs LLM review passes over the PR diff through a shared `VcsProvider` abstraction, and inline findings, a summary report, and a merge-gating status are posted back to the PR on whichever platform it came from.

## Current State (as of v1.0)

Shipped 2026-07-14. Bitbucket Cloud is a first-class second provider at full parity with GitHub: webhook ingestion, diff-based review, inline findings, Code Insights report, build status, encrypted bot-credential storage, dashboard OAuth login, and a provider-aware "add repo" flow. GitHub's existing behavior is unchanged throughout (NREG-02 held continuously across all 6 phases and re-verified at milestone audit). See `.planning/milestones/v1.0-ROADMAP.md` and `v1.0-REQUIREMENTS.md` for full phase-by-phase detail, and `.planning/milestones/v1.0-MILESTONE-AUDIT.md` for the closeout audit.

## Next Milestone Goals

v1 deliberately scoped to table-stakes parity; the two differentiators deferred during requirements definition are the natural v1.1 candidates (see Active below). No v1.1 scope has been committed yet — run `/gsd-new-milestone` to define it.

## Core Value

A Bitbucket Cloud pull request receives the same automated AI review — inline findings posted back to the PR — that a GitHub PR already gets, from one Codra instance, without breaking existing GitHub support.

*Still the right priority after shipping — this was the single goal of v1.0 and it holds end-to-end (see Cross-Phase Integration in the v1.0 audit).*

## Requirements

### Validated

<!-- Inferred from existing code (codebase map, 2026-07-12). These already shipped pre-milestone. -->

- ✓ GitHub App webhook ingestion with HMAC signature verification (`core/verify.ts`, `routes/webhook.ts`) — existing
- ✓ Durable, resumable review pipeline over PR diffs (prepare → review → finalize) via Cloudflare Workflows (`workflows/review.ts`, `core/review.ts`) — existing
- ✓ Inline findings + check run posted back to GitHub PRs (`core/github.ts`, `services/github.ts`, `services/formatter.ts`) — existing
- ✓ GitHub OAuth dashboard login with KV-backed sessions (`core/github-oauth.ts`, `core/sessions.ts`) — existing
- ✓ Per-repo model routing (chains, fallbacks, size overrides) across OpenAI/Anthropic/Google/Workers AI (`services/model.ts`, `models/*`) — existing
- ✓ React dashboard for repos, model config, job history, DLQ replay (`src/client/`) — existing

<!-- Shipped this milestone — v1.0, 2026-07-14. -->

- ✓ A VCS-provider abstraction so review, webhook, and posting logic are not GitHub-specific — v1.0 (`VcsProvider` interface, `VcsService.forRepo`/`forProvider` branch point)
- ✓ Bitbucket Cloud webhook ingestion (PR created/updated) with verification appropriate to Bitbucket Cloud — v1.0 (`POST /webhook/bitbucket`, HMAC via per-repo secret, fail-closed)
- ✓ Bitbucket Cloud "review bot" authentication — v1.0 (Repository/Workspace Access Token, Bearer; AES-GCM encrypted storage mirroring `core/llm-crypto.ts`)
- ✓ Fetch Bitbucket Cloud PR diffs into the existing review pipeline — v1.0 (`core/diff.ts` generalized for Bitbucket's 200-file/8,000-line caps)
- ✓ Post inline review findings back onto Bitbucket Cloud PRs (comments + summary/status) — v1.0 (path/line-anchored comments, Code Insights report, build status)
- ✓ Bitbucket OAuth dashboard login — v1.0 (second OAuth consumer, `account_id`-keyed allow-list, never `username`)
- ✓ Repos declare their provider (github | bitbucket) in config/DB; dashboard supports adding Bitbucket repos — v1.0 (provider picker + transactional `POST /api/repos/bitbucket`)
- ✓ Existing GitHub flows remain fully working (no regression) after the abstraction is introduced — v1.0 (NREG-02, held through all 6 phases + milestone audit)

### Active

<!-- Deferred from v1 requirements definition (2026-07-12) as differentiators, not table stakes. Candidates for next milestone — not yet committed. -->

- [ ] **ANNO-01**: Per-line Code Insights annotations (diff-gutter markers) mirroring inline comments
- [ ] **WS-01**: Workspace-level token/webhook covering many repos to reduce per-repo onboarding friction

### Out of Scope

- Bitbucket Data Center / Server (self-hosted Bitbucket) — different API dialect and auth; Cloud only, confirmed correct through v1.0
- Atlassian Connect app model — end-of-support 2026-12, no new registrations since Feb 2026; would have been overweight for single-tenant self-hosted (confirmed by AUTH-01 research; Repository/Workspace Access Token used instead)
- App passwords for Bitbucket bot auth — fully removed by Atlassian on 2026-07-28; access-token model avoids this cliff entirely
- GitLab, Azure DevOps, or other VCS providers — not in scope
- Replacing or deprecating GitHub support — GitHub and Bitbucket coexist, confirmed by continuous NREG-02 compliance
- Bitbucket Pipelines / CI integration — not part of the PR-review use case
- Upstream-contribution polish (exhaustive docs, CLA, broad config surface) — nice-to-have, not required; target is the user's own self-hosted deployment

## Business Context

<!-- Internal/self-hosted use — not a monetized feature. -->

- **Customer**: The user's own team, reviewing PRs on their Bitbucket Cloud workspace via a self-hosted Codra instance.
- **Success metric**: Bitbucket Cloud PRs get AI review at parity with GitHub, GitHub unaffected. **Achieved** — 22/22 v1 requirements satisfied, full regression suite green (387/387 tests) at milestone close.

## Context

- **Brownfield**: mature codebase; see `.planning/codebase/` for the full map (STACK, ARCHITECTURE, INTEGRATIONS, STRUCTURE, CONVENTIONS, TESTING, CONCERNS as of 2026-07-12).
- **Two coexisting VCS providers**: GitHub and Bitbucket Cloud both run through the same `VcsProvider` interface and `VcsService` branch point (`core/review.ts`); webhook dedup/insert/supersede/enqueue is shared (`core/webhook-ingest.ts`); credentials for both are encrypted at rest (AES-GCM).
- **Bot auth resolved**: Bitbucket bot authentication uses a Repository/Workspace Access Token (Bearer), not Atlassian Connect and not app passwords — lighter-weight than GitHub's App/JWT model, encrypted alongside LLM provider keys.
- **Webhook verification**: Bitbucket Cloud uses `X-Hub-Signature` HMAC via a per-repo secret (repo identified from payload before verification, fails closed) — same shape as GitHub's, generalized in `core/verify.ts`.
- **Contract-first**: all wire/queue/DB-JSON shapes live in `src/shared/schema.ts` (Zod), now with a `provider` discriminator throughout.
- **Resource constraints carry over**: the Cloudflare Workers 50-subrequest/invocation limit and the durable-Workflow fresh-instance handoff already shaped the GitHub pipeline; Bitbucket's diff caps (200 files/8,000 lines) and ~1,000 req/hr rate limit are budgeted the same way.
- **Known tech debt** (non-blocking, see `.planning/milestones/v1.0-MILESTONE-AUDIT.md` for full detail): a cosmetic vitest hoisting warning in `test/webhook-ingest.spec.ts`; `computeCredentialStatus` fails open on an unparseable expiry string (unreachable via the write path, Zod rejects malformed dates with 400); Phase 5 has no recorded Nyquist `VALIDATION.md` (process gap, not functional); SUMMARY.md frontmatter omits `requirements-completed` for AUTH-02/BB-04/REV-01/02/03 (documentation-consistency only — all independently verified in each phase's VERIFICATION.md).

## Constraints

- **Tech stack**: Cloudflare Workers + Workflows + Queues + KV + Hyperdrive, external PostgreSQL, Hono, React 19, TypeScript, Zod, raw SQL (no ORM). Bitbucket support fits this stack with no new hosting dependency — confirmed through v1.0.
- **Compatibility**: Zero regression to existing GitHub review flows; GitHub and Bitbucket run in the same deployed Worker — held continuously through v1.0.
- **Platform**: Bitbucket **Cloud** only (bitbucket.org), not Data Center/Server.
- **Pattern**: Hand-rolled REST client (no heavy SDK) — `core/bitbucket.ts` mirrors `core/github.ts`; provider adapter behind a shared interface; contract shapes in `src/shared/`; one DB module per domain; migrations as numbered SQL files.
- **Data shapes first**: `src/shared/schema.ts` changes precede implementation when introducing provider tagging.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Bitbucket **Cloud** only (not Data Center) | User's workspace is on Bitbucket Cloud; DC is a separate API dialect | ✓ Good |
| **Coexist** with GitHub (multi-provider), don't replace | Keep existing GitHub capability; one instance serves both | ✓ Good |
| **Full parity** in v1 (webhook review + inline comments + Bitbucket OAuth login) | Bitbucket users should get the same experience as GitHub users | ✓ Good |
| Bot auth: **Repository/Workspace Access Token** (Bearer), not Atlassian Connect or app passwords | Connect is EOL 2026-12 and heavyweight for single-tenant; app passwords removed 2026-07-28 | ✓ Good |
| Target = user's **own self-hosted deployment** | Sets the quality bar (parity, tests) without requiring full upstream polish | ✓ Good |
| `VcsProvider` interface + single `VcsService` branch point in `core/review.ts` (Phase 2) | Zero-behavior-change refactor gated by a pre-flip regression net, rather than a big-bang rewrite | ✓ Good — full suite passed unmodified through the flip |
| Shared `core/webhook-ingest.ts` extracted before Bitbucket existed (Phase 3) | GitHub's dedup/insert/supersede/enqueue logic reused byte-identical by the second caller instead of duplicated | ✓ Good |
| Bitbucket credentials AES-GCM encrypted, mirroring `core/llm-crypto.ts` (Phase 4) | Reuse a proven crypto pattern rather than invent a new one for a second secret type | ✓ Good |
| D-29: APP_KV `updates-email` key format changed to `updates-email:${provider}:${id}` (Phase 6) | Needed provider-scoped keys for dual-login; old keys orphan and users re-subscribe on next login | ✓ Good — intentional, documented tradeoff, not a regression |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-07-14 after v1.0 milestone*
