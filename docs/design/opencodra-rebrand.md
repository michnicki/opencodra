# OpenCodra Rebrand — Design Spec

**Date:** 2026-07-15
**Status:** Approved — ready for implementation planning
**Author/maintainer:** Thomas Michnicki
**Upstream:** Fork of [Codra](https://github.com/devarshishimpi/codra) by Devarshi Shimpi

## 1. Summary & scope

Rebrand this fork from **Codra** to **OpenCodra**. Scope is **brand-only**: every user-facing and in-repo surface is renamed, but all running Cloudflare/GitHub operational identities are left untouched so there is zero downtime and no re-registration.

**Why fork:** the original Codra requires a **Contributor License Agreement (CLA)** to accept contributions. OpenCodra removes that barrier — contributions are accepted under AGPL-3.0 with **no CLA**. This rationale is the README's lead message, and the CLA requirement is dropped from the contribution docs. (The `codra.run` CLA integration was already removed in a prior cleanup.)

**Explicitly UNCHANGED (operational + internal):**
- Cloudflare worker name `codra`; domain `codra.tmichnicki.workers.dev`
- Queue `codra-review-jobs`; workflow `codra-review-workflow`; KV/Hyperdrive bindings
- GitHub App slug `CodraApp`; `BOT_USERNAME=codraapp`; the `@codra-app` PR-comment trigger (stays literal — it is functional)
- Internal identifiers: `codra-toast-title` CSS class, `codra-bot`/`codra-app` User-Agent fallbacks, code comments referencing Codra

## 2. Decisions

| Area | Decision |
|---|---|
| Name | `Codra` → `OpenCodra` in all display copy |
| Wordmark | Two-tone: lime `Open` + base-color `Codra`, weight 800, letter-spacing −0.03em |
| Glyph | New **circular open-ring "O"** (replaces the C-mark) |
| Logo rendering | In-app: render glyph SVG + styled text (`<span>Open</span>Codra`) instead of a baked-wordmark SVG — crisp, two-tone, font-independent |
| Package | `package.json` name `codra` → `opencodra` |
| Repo links | `github.com/devarshishimpi/codra` and `github.com/michnicki/codra` → `github.com/michnicki/opencodra` |
| Attribution | `package.json` author → Thomas Michnicki; README "Forked from Codra by Devarshi Shimpi" + link; **LICENSE unchanged** |
| Security contact | `SECURITY.md`/`CODE_OF_CONDUCT.md` → GitHub Security Advisories (private reporting); no personal email |

## 3. Visual identity

### Glyph — circular open-ring "O" (final: variant V1)
Lime open ring on a tile, gap at top-right, round caps. Mirrors the existing dark/light tile convention (dark = black tile + `#C2D200`; light = white tile + `#B5C400`).

`public/icons/opencodra-icon-dark.svg`:
```svg
<svg width="100" height="100" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="100" height="100" fill="black"/>
  <circle cx="50" cy="50" r="27" fill="none" stroke="#C2D200" stroke-width="12"
          stroke-linecap="round" stroke-dasharray="132 38" transform="rotate(-16 50 50)"/>
</svg>
```

`public/icons/opencodra-icon-light.svg`: identical but `fill="white"` tile and `stroke="#B5C400"`.

### Wordmark — two-tone
`Open` in the glyph lime, `Codra` in the base foreground color, both weight 800. Rendered as text in the app font (system-ui bold stack), not outlined paths.

### Full lockup
Replace the current `codra-fullicon-{dark,light}.svg` `<img>` usage (glyph + baked "Codra" text) with a small **logo lockup component**: the open-ring glyph SVG + the two-tone wordmark as styled text. Used in landing, login, and the app-shell sidebar.

## 4. Change list (grouped for atomic commits)

### Group A — Display/brand text
- `index.html`: `<title>` → `OpenCodra | AI Code Reviews`; meta description.
- Client UI copy: `pages/landing.tsx`, `pages/login.tsx` (allow-list error strings), `pages/settings.tsx` ("this OpenCodra instance"), `pages/repos/add-bitbucket.tsx`, `pages/vcs-credentials.tsx`, logo `alt` text in `app-shell.tsx`.
- Server PR-comment strings — **`services/formatter.ts`**: `### Codra Review` → `### OpenCodra Review`, `About Codra in GitHub` → `About OpenCodra`, body copy ("Your team has set up OpenCodra…", "If OpenCodra has suggestions…", "OpenCodra can also answer…"). Keep `@${botUsername}` (resolves to `@codra-app`).
- Server check-run summaries — **`core/review.ts`** (~lines 711/753/1037): "Codra has started reviewing…" → "OpenCodra…", etc.
- **Client/server sync — `components/features/job-detail/job-review-overview.tsx`**: the heading-strip detection currently matches `'Codra Review'` / `'About Codra'`. Update to match `'OpenCodra Review'` AND keep matching the legacy `'Codra Review'` so already-posted comments still render correctly.

### Group B — Visual assets
- Add `public/icons/opencodra-icon-{dark,light}.svg` (§3); remove `codra-icon-*.svg`.
- Add `src/client/assets/opencodra-fullicon-{dark,light}.svg` **or** replace fullicon `<img>` usage with the logo lockup component (preferred). Update the 3 import/usage sites (`app-shell.tsx`, `landing.tsx`, `login.tsx`) and the `/icons/codra-icon-dark.svg` reference in `app-shell.tsx`.
- Regenerate `favicon.ico` from the new open-ring mark.
- **Flagged for user (raster/complex):** `public/assets/codra-dashboard.png` (screenshot — regen after deploy), `public/assets/codra-gh-banner-{dark,light}.svg` (README banner — I'll attempt if text-based, else flag).

### Group C — Package + repo identity
- `package.json`: `name` → `opencodra`; `repository.url`, `homepage`, `bugs.url` → `https://github.com/michnicki/opencodra`.
- Repoint in-app repo links (`app-shell.tsx`, `dashboard.tsx`, `jobs.tsx`, `repos.tsx`, `landing.tsx`, `settings.tsx`) → `github.com/michnicki/opencodra`.
- **User action:** rename the GitHub repo `michnicki/codra` → `michnicki/opencodra` (auto-redirects the old URL).

### Group D — Attribution + docs
- `package.json` `author` → `Thomas Michnicki`.
- `README.md`: rebrand title/badges/copy to OpenCodra; **lead with the fork rationale** ("Fork of Codra by Devarshi Shimpi — exists to drop the CLA; no Contributor License Agreement required"); update Contributing section to state **no CLA**; repoint Website/Docs/Issues links (drop dead `codra.run` links → repo/issues); reflect GitHub **and Bitbucket** support (accurate for this fork); keep the screenshot working (rename `codra-dashboard.png` → `opencodra-dashboard.png` with the asset group).
- `.claude/CLAUDE.md` "Pull Requests" section currently says "Open PRs against `dev`… A CLA check runs on PRs" — update to remove the CLA statement (and correct the branch convention) since it no longer applies.
- `SECURITY.md` / `CODE_OF_CONDUCT.md`: replace `me@devarshi.dev` with GitHub Security Advisories / repo issues routing.
- `LICENSE`: **unchanged** (Devarshi Shimpi copyright retained — AGPL). Optionally add a fork-modifications copyright line for Thomas Michnicki.
- `CHANGELOG.md`: leave historical entries; optionally add a rebrand entry.

## 5. Verification
- `npm run typecheck` — clean.
- `npm test` — full suite green (watch the `job-review-overview` detection + any formatter snapshot tests).
- `npm run build` / `vite build` — confirms all renamed asset imports resolve.
- Post-deploy: visual check of landing/login/dashboard branding + one live PR review comment showing "OpenCodra Review" with the `@codra-app` trigger intact.

## 6. Execution
Implemented via the project's **GSD** workflow (per `.claude/CLAUDE.md`), one atomic commit per group (A–D). Deploy (`npm run deploy`) and push to `michnicki/opencodra` on the maintainer's go.

## 7. Open items for the user
1. Rename the GitHub repo to `michnicki/opencodra`.
2. Regenerate the raster dashboard screenshot and (if not text-based SVG) the GitHub banner with OpenCodra branding.
3. Confirm whether to add a fork-modifications copyright line to `LICENSE`.
