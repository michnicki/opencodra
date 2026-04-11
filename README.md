# Codra

Codra is a private PR review bot built for Cloudflare Workers, Hono, React, Queues, and Neon.

## Quick Start

1. `npm install`
2. Create the KV namespace and Queues referenced in [wrangler.jsonc](/C:/Users/devar/Dropbox/Documents/GitHub/codra/wrangler.jsonc)
3. Add Wrangler secrets:
   - `APP_PRIVATE_KEY`
   - `GITHUB_APP_WEBHOOK_SECRET`
   - `GITHUB_APP_ID`
   - `GEMINI_API_KEY`
   - `NEON_DATABASE_URL`
   - `DASHBOARD_PASSWORD`
4. Run migrations from [db/migrations/001_initial.sql](/C:/Users/devar/Dropbox/Documents/GitHub/codra/db/migrations/001_initial.sql)
5. `npm run dev`

## Scripts

- `npm run dev` runs the client build watcher and `wrangler dev` together.
- `npm run build` builds the React SPA and refreshes Worker env types.
- `npm run test` runs the Vitest suite.
- `npm run deploy` builds and deploys the Worker.
