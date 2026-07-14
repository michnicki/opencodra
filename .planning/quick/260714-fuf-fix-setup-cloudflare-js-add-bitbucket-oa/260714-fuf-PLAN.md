---
task: 260714-fuf
description: Fix setup-cloudflare.js: add Bitbucket OAuth secrets prompts and BITBUCKET_AUTH_CALLBACK_URL var wiring
type: execute
autonomous: true
files_modified:
  - scripts/setup-cloudflare.js
must_haves:
  truths:
    - "Running `npm run setup:cloudflare` and confirming the secrets step prompts for BITBUCKET_CLIENT_ID and BITBUCKET_CLIENT_SECRET in addition to the existing 8 secrets"
    - "A fresh setup run (custom domain or workers.dev) writes BITBUCKET_AUTH_CALLBACK_URL into wrangler.jsonc derived from the same appUrl the user entered, mirroring how AUTH_CALLBACK_URL is derived"
  artifacts:
    - scripts/setup-cloudflare.js
  key_links:
    - "requiredSecrets array (main(), Secrets step) -> existing prompts()/setSecret() loop -> npx wrangler secret put <name>"
    - "bitbucketCallbackUrlRegex replace on wranglerConfig -> fs.writeFileSync(WRANGLER_JSONC_PATH, wranglerConfig)"
---

<objective>
Bring `scripts/setup-cloudflare.js` (the interactive `npm run setup:cloudflare` provisioning script) up to date with wrangler.jsonc's current contract, which already requires `BITBUCKET_CLIENT_ID` / `BITBUCKET_CLIENT_SECRET` secrets and a `BITBUCKET_AUTH_CALLBACK_URL` var (added in Phase 06's Bitbucket OAuth work, commit abc3fe4). The script predates that work and currently has two gaps: it never prompts for the two Bitbucket secrets, and its wrangler.jsonc rewrite step never populates `BITBUCKET_AUTH_CALLBACK_URL` from the domain the user configures.

Purpose: A fresh `npm run setup:cloudflare` run must fully satisfy wrangler.jsonc's `secrets.required` array and `vars` block for both providers — otherwise a new deployment silently ends up missing Bitbucket OAuth credentials and posts a stale/wrong Bitbucket callback URL.

Output: `scripts/setup-cloudflare.js` updated with the two additions; no other behavior of the script changes.
</objective>

<execution_context>
@/home/thomas/repos-ext/codra/.claude/gsd-core/workflows/execute-plan.md
@/home/thomas/repos-ext/codra/.claude/gsd-core/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@wrangler.jsonc
@.dev.vars.example
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add Bitbucket OAuth secrets to requiredSecrets and BITBUCKET_AUTH_CALLBACK_URL to the wrangler.jsonc rewrite</name>
  <files>scripts/setup-cloudflare.js</files>
  <action>
Make exactly two additions to scripts/setup-cloudflare.js. Do not modify any other line.

1. In the `requiredSecrets` array declared inside `main()` (the "Secrets" step, currently listing `APP_PRIVATE_KEY`, `GITHUB_APP_ID`, `GITHUB_APP_WEBHOOK_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `LLM_CONFIG_ENCRYPTION_KEY`, `CF_API_TOKEN`, `CF_ACCOUNT_ID`), append two more string entries immediately after `"CF_ACCOUNT_ID"`: `"BITBUCKET_CLIENT_ID"` and `"BITBUCKET_CLIENT_SECRET"`. This matches wrangler.jsonc's `secrets.required` ordering exactly. No other code changes are needed for these two secrets — they automatically flow through the existing `confirmSecrets` prompt loop (`prompts()` call with `style: 'password'`, `initial` sourced from the `.dev.vars`-derived `env` map via `getEnvVars()`, then `setSecret(secretName, secretValue)` which shells out to `npx wrangler secret put`).

2. In the "Config Update" step (step 7), immediately after the existing `callbackUrlRegex` block that matches and replaces the quoted `AUTH_CALLBACK_URL` value in `wranglerConfig` with `${escapeJson(appUrl)}/auth/github/callback`, add a mirrored regex replace for `BITBUCKET_AUTH_CALLBACK_URL`: build a regex matching the quoted `BITBUCKET_AUTH_CALLBACK_URL` value in `wranglerConfig`, and replace it with the same `appUrl` variable (already computed earlier from the Domain Configuration prompts, identical for both workers.dev and custom-domain paths) plus the suffix `/auth/bitbucket/callback`, passed through the existing `escapeJson` helper — same construction as the GitHub callback line directly above it. `configChanged` is already unconditionally set to `true` right after this block of direct-var replaces, so no additional assignment of `configChanged` is required.

Keep formatting (2-space indent, single quotes for JS strings, template literals for the replacement string) consistent with the surrounding lines you are inserting next to.
  </action>
  <verify>
    <automated>node --check scripts/setup-cloudflare.js && grep -c '"BITBUCKET_CLIENT_ID"' scripts/setup-cloudflare.js && grep -c '"BITBUCKET_CLIENT_SECRET"' scripts/setup-cloudflare.js && grep -c 'BITBUCKET_AUTH_CALLBACK_URL' scripts/setup-cloudflare.js</automated>
  </verify>
  <done>
`node --check scripts/setup-cloudflare.js` exits 0 (valid syntax). The `requiredSecrets` array literal contains `BITBUCKET_CLIENT_ID` and `BITBUCKET_CLIENT_SECRET` (10 entries total, in the same order as wrangler.jsonc's `secrets.required`). The Config Update step contains a `BITBUCKET_AUTH_CALLBACK_URL` regex-replace pair built from `appUrl` and `escapeJson`, structurally identical to the existing `AUTH_CALLBACK_URL` replace. No other line of the file is changed (confirm via `git diff scripts/setup-cloudflare.js` showing only these two hunks).
  </done>
</task>

</tasks>

<verification>
Run `node --check scripts/setup-cloudflare.js` (syntax valid) and `git diff --stat scripts/setup-cloudflare.js` (only one file touched, small diff). Manually confirm the diff contains exactly the two additions described above and nothing else — no reordering, no reformatting of unrelated lines.
</verification>

<success_criteria>
- `requiredSecrets` in `scripts/setup-cloudflare.js` includes `BITBUCKET_CLIENT_ID` and `BITBUCKET_CLIENT_SECRET`, matching wrangler.jsonc's `secrets.required` array.
- The wrangler.jsonc rewrite logic in `scripts/setup-cloudflare.js` populates `BITBUCKET_AUTH_CALLBACK_URL` from `appUrl` the same way it populates `AUTH_CALLBACK_URL`.
- No other part of `scripts/setup-cloudflare.js` is modified.
- No tests added (none exist for this script; not required by this task).
</success_criteria>

<output>
Create `.planning/quick/260714-fuf-fix-setup-cloudflare-js-add-bitbucket-oa/260714-fuf-SUMMARY.md` when done
</output>
