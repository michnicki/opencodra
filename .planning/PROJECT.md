# Codra — Bitbucket Cloud Support

## What This Is

Codra is self-hosted AI code review for pull requests, running entirely on Cloudflare (Workers, Queues, KV, Hyperdrive, Workers AI) with an external PostgreSQL database. Today it reviews **GitHub** PRs: a GitHub App webhook enqueues review jobs, a durable Cloudflare Workflow runs LLM review passes over the PR diff, and inline findings are posted back to the PR. This milestone adds **Bitbucket Cloud** as a first-class second provider, coexisting with GitHub so a single self-hosted instance can review PRs on either platform.

## Core Value

A Bitbucket Cloud pull request receives the same automated AI review — inline findings posted back to the PR — that a GitHub PR already gets, from one Codra instance, without breaking existing GitHub support.

## Requirements

### Validated

<!-- Inferred from existing code (codebase map, 2026-07-12). These already ship and work. -->

- ✓ GitHub App webhook ingestion with HMAC signature verification (`core/verify.ts`, `routes/webhook.ts`) — existing
- ✓ Durable, resumable review pipeline over PR diffs (prepare → review → finalize) via Cloudflare Workflows (`workflows/review.ts`, `core/review.ts`) — existing
- ✓ Inline findings + check run posted back to GitHub PRs (`core/github.ts`, `services/github.ts`, `services/formatter.ts`) — existing
- ✓ GitHub OAuth dashboard login with KV-backed sessions (`core/github-oauth.ts`, `core/sessions.ts`) — existing
- ✓ Per-repo model routing (chains, fallbacks, size overrides) across OpenAI/Anthropic/Google/Workers AI (`services/model.ts`, `models/*`) — existing
- ✓ React dashboard for repos, model config, job history, DLQ replay (`src/client/`) — existing

### Active

<!-- This milestone: Bitbucket Cloud at parity with GitHub, coexisting. -->

- [ ] A VCS-provider abstraction so review, webhook, and posting logic are not GitHub-specific
- [ ] Bitbucket Cloud webhook ingestion (PR created/updated) with verification appropriate to Bitbucket Cloud
- [ ] Bitbucket Cloud "review bot" authentication (app model TBD — resolved in research: Atlassian Connect app vs OAuth consumer + workspace/repo access tokens)
- [ ] Fetch Bitbucket Cloud PR diffs into the existing review pipeline
- [ ] Post inline review findings back onto Bitbucket Cloud PRs (comments + a summary/status equivalent to the GitHub check run)
- [ ] Bitbucket OAuth dashboard login (add as a second login provider alongside GitHub)
- [ ] Repos declare their provider (github | bitbucket) in config/DB; dashboard supports adding Bitbucket repos
- [ ] Existing GitHub flows remain fully working (no regression) after the abstraction is introduced

### Out of Scope

- Bitbucket Data Center / Server (self-hosted Bitbucket) — different API dialect and auth; Cloud only for this milestone
- GitLab, Azure DevOps, or other VCS providers — not in scope
- Replacing or deprecating GitHub support — GitHub and Bitbucket coexist
- Upstream-contribution polish (exhaustive docs, CLA, broad config surface) — nice-to-have, not required; target is the user's own self-hosted deployment

## Business Context

<!-- Internal/self-hosted use — not a monetized feature. -->

- **Customer**: The user's own team, reviewing PRs on their Bitbucket Cloud workspace via a self-hosted Codra instance.
- **Success metric**: Bitbucket Cloud PRs get AI review at parity with GitHub, GitHub unaffected.

## Context

- **Brownfield**: mature codebase; see `.planning/codebase/` for the full map (STACK, ARCHITECTURE, INTEGRATIONS, STRUCTURE, CONVENTIONS, TESTING, CONCERNS as of 2026-07-12).
- **GitHub is woven through many seams** that Bitbucket must parallel: `core/github.ts` (`GitHubClient`, hand-rolled REST, no SDK), `services/github.ts` (`GitHubService`), `routes/webhook.ts`, `core/verify.ts` (HMAC), `core/github-oauth.ts` (dashboard login), `@shared/github` types, and repo/job identity in the DB.
- **Auth mismatch**: GitHub uses a GitHub App (JWT → installation access token). Bitbucket Cloud has no exact analog; candidate models are an Atlassian Connect app (closest parity, heaviest) or an OAuth consumer + workspace/repository access tokens (lighter). This is the single biggest unknown and is the priority of the research phase.
- **Webhook verification differs**: Bitbucket Cloud's webhook signing/verification story is not identical to GitHub's `X-Hub-Signature` HMAC — research must confirm the correct verification approach.
- **Contract-first**: all wire/queue/DB-JSON shapes live in `src/shared/schema.ts` (Zod). New provider-tagged shapes should be defined there first (per CLAUDE.md).
- **Resource constraints carry over**: the Cloudflare Workers 50-subrequest/invocation limit and the durable-Workflow fresh-instance handoff already shape the pipeline; Bitbucket API calls must respect the same budgeting.

## Constraints

- **Tech stack**: Cloudflare Workers + Workflows + Queues + KV + Hyperdrive, external PostgreSQL, Hono, React 19, TypeScript, Zod, raw SQL (no ORM). Bitbucket support must fit this stack — no new hosting dependency.
- **Compatibility**: Zero regression to existing GitHub review flows; GitHub and Bitbucket must run in the same deployed Worker.
- **Platform**: Bitbucket **Cloud** only (bitbucket.org), not Data Center/Server.
- **Pattern**: Follow existing conventions — hand-rolled REST client (no heavy SDK), provider adapter behind a shared interface, contract shapes in `src/shared/`, one DB module per domain, migrations as numbered SQL files.
- **Data shapes first**: change `src/shared/schema.ts` before implementation when introducing provider tagging.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Bitbucket **Cloud** only (not Data Center) | User's workspace is on Bitbucket Cloud; DC is a separate API dialect | — Pending |
| **Coexist** with GitHub (multi-provider), don't replace | Keep existing GitHub capability; one instance serves both | — Pending |
| **Full parity** in v1 (webhook review + inline comments + Bitbucket OAuth login) | Bitbucket users should get the same experience as GitHub users | — Pending |
| Bot auth model **deferred to research** | Bitbucket Cloud has no direct GitHub App analog; needs investigation before committing | — Pending |
| Target = user's **own self-hosted deployment** | Sets the quality bar (parity, tests) without requiring full upstream polish | — Pending |

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
*Last updated: 2026-07-12 after initialization*
