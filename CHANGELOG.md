# Changelog

## v0.9.2

### What's New

- **UI Redesign:** Full visual overhaul of the dashboard, landing page, and auth flows with an updated color system, improved dark mode, and a cleaner layout overall.
- **Code Splitting:** All pages now use `React.lazy` for async loading, reducing initial bundle size and improving load times.
- **Custom LLM Providers:** Manage custom OpenAI-compatible API providers directly from the dashboard. Rate limits are optional. No more hardcoded keys in wrangler config.
- **Cloudflare Setup Script:** A new Node.js script automates the full Cloudflare deployment setup, making self-hosting significantly easier.
- **Increased Review Capacity:** Max files processed per review raised from 15 to 100.

### Improvements

- Review jobs are now resumable and lease-aware, stalled reviews can recover automatically.
- Added retry logic for transient model provider failures.
- Optimized job polling with ETag caching and adaptive delays.
- Improved settings UI, error reporting, and API robustness across the board.
- Added GitHub Actions CI with a disposable test environment for the full test suite.

### Bug Fixes

- Fixed `APP_PRIVATE_KEY` parsing for single-line strings with literal `\n` sequences.
- Fixed database migration failures on existing deployments.
- Fixed duplicate `/api/auth/updates-email` calls on page load.
- Fixed file review status bar rendering on the dashboard.

**Full Changelog**: https://github.com/devarshishimpi/codra/commits/v0.9.2
