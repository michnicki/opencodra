# design-sync notes — OpenCodra

## OpenCodra rebrand (2026-07-16)
- This DS was rebranded **Codra → OpenCodra**. Identity now: `pkg: opencodra`,
  `globalName: OpenCodraUI` (the design agent imports `window.OpenCodraUI` /
  `from 'opencodra'`), synced to a **fresh project "OpenCodra Design System"**
  (`fc2aa3e1-0cd1-4461-b1e5-6e560ff12c7f`).
- The old **"Codra Design System"** project (`0804ef43-4a61-4815-a419-d67262171cf9`)
  is **retired** — the sync tool can't delete projects, so delete it from the
  claude.ai/design UI when ready.
- The 9 UI primitives are brand-neutral and were **unchanged** by the app rebrand
  (`src/client/components/ui/` untouched) — only DS metadata + preview brand
  strings changed. Preview imports are `from 'opencodra'`; example copy is
  OpenCodra-branded (Alert/ConfirmDialog body text, Input webhook placeholder).
- `cssEntry`/`buildCmd` compiled-CSS artifact renamed `codra-compiled.css` →
  `opencodra-compiled.css` (gitignored, regenerated each sync).

## Repo shape
- **OpenCodra is an application, not a packaged design system.** No library build, no
  `dist/` component entry, no `.d.ts` exports. It's synced via a hand-written
  **barrel entry** (`.design-sync/bundle-entry.tsx`) passed as `--entry`, which
  re-exports the 9 UI primitives from `src/client/components/ui/`.
- `synthEntry` is therefore FALSE (a real `--entry` is provided), so the
  component list comes entirely from `componentSrcMap` in config.json.

## Bundle
- Named re-exports in the barrel let esbuild tree-shake out `StatusBadge`
  (badge.tsx), which imports `LiveReviewStepper` + `@shared/schema` — app/feature
  code we do NOT want in the DS bundle. Do not switch the barrel to `export *`.
- react/react-dom are externalized to `window` by the converter; everything else
  (radix, lucide, class-variance-authority, motion/react) bundles from
  `node_modules`.
- tsconfig path aliases (`@client`, `@shared`, `@`) resolve via `cfg.tsconfig`.

## CSS / theme
- No component-library stylesheet exists. `cssEntry` points at the app's
  **compiled Tailwind CSS** — `cfg.buildCmd` runs `npx vite build` then copies the
  hashed `dist/client/assets/*.css` to `.design-sync/opencodra-compiled.css`
  (gitignored, regenerated every sync). That file is the whole-app CSS superset:
  it contains every materialized utility + the oklch light/dark theme tokens, so
  the primitives are fully styled. Larger than a component-scoped build, but
  guaranteed complete.

## Fonts
- IBM Plex Sans + JetBrains Mono, loaded via a **remote Google Fonts `@import`**
  at the top of `src/client/app.css` (no local font files). Expect `[FONT_REMOTE]`
  (informational) — the families load at runtime in the browser. No action.

## Excluded
- `StatusBadge` (app-coupled), `buttonVariants` / `badgeVariants` (CVA helpers,
  not components).

## Playwright / render check (IMPORTANT)
- The render check (`package-validate.mjs`, `package-capture.mjs`) and the review
  server need chromium. This is NixOS: playwright's downloaded chromium (rev 1228,
  matching the repo's playwright 1.61.1) only launches with the shared libs that
  `shell.nix` puts on `LD_LIBRARY_PATH`. **Run every render/capture/serve command
  inside `nix-shell --run "…"`** from the repo root, e.g.
  `nix-shell --run "node .ds-sync/package-validate.mjs ./ds-bundle"`.
  Outside nix-shell it fails with `[RENDER_SKIPPED] … Target page … has been closed`.
- (`DS_CHROMIUM_PATH` could point at the Nix system chromium as an alternative, but
  the shell.nix + downloaded-chromium path is what this repo uses.)

## Known render warns
- (none recorded yet — Badge/Card [RENDER_BLANK] on the first build were just
  unauthored floor cards rendering empty components; resolved by authoring previews.)

## Re-sync risks
- `bundle-entry.tsx` and `componentSrcMap` must track `src/client/components/ui/`.
  Add/remove/rename a primitive there → update BOTH, or the sync drifts silently.
- `cssEntry` depends on the app build emitting a single CSS at
  `dist/client/assets/*.css`. If Vite's output layout changes (multiple CSS
  chunks, different dir), update `buildCmd`/`cssEntry`.
- Dark mode is a `.dark`-class variant (`@custom-variant dark` in app.css).
  Previews render light by default; dark states need explicitly authored cells.
- The compiled CSS is app-wide; unused-in-DS utilities ride along. Harmless, but
  it's not a minimal DS stylesheet.
