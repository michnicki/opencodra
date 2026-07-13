-- Phase 5 / D-01: extend the repositories table so a Bitbucket repo row can be inserted WITHOUT a
-- numeric installation_id (Bitbucket has no GitHub-App-equivalent numeric id) and is keyed by its
-- (vcs_provider, workspace, repo) identity tuple instead of the existing GitHub-only
-- (vcs_provider, owner, repo) key. This migration is additive and re-run safe; it does NOT
-- backfill, drop, or rename any existing column.
--
-- Three coordinated changes:
--   1. ALTER COLUMN installation_id DROP NOT NULL (REV-M-3 / D-01) -- a Bitbucket row has no
--      installation_id, so the existing NOT NULL constraint from 001_initial.sql would reject
--      INSERTs on the new provider branch. The DROP NOT NULL is wrapped in a DO $$ guard because
--      PostgreSQL has no `ALTER COLUMN ... DROP NOT NULL IF NOT NULL` (no IF NOT NULL for DROP
--      NOT NULL); the information_schema existence check is the canonical pattern in this codebase
--      (see 003_vcs_provider_foundation.sql:25-32 for the pg_constraint guard precedent).
--   2. ADD COLUMN workspace TEXT NULL -- the canonical identity column for Bitbucket rows. NULL
--      means "not a Bitbucket row" (GitHub rows leave it NULL). The `ADD COLUMN IF NOT EXISTS`
--      makes the migration idempotent under re-run; nullable, no DEFAULT (review finding 10 style:
--      no implicit backfill that would silently classify every existing GitHub row as a Bitbucket
--      workspace).
--   3. UNIQUE (vcs_provider, workspace, repo) -- the canonical identity key for Bitbucket rows.
--      The existing GitHub UNIQUE (vcs_provider, owner, repo) from migration 003 stays untouched;
--      a Bitbucket repo and a GitHub repo can share an owner/repo pair because the leading
--      vcs_provider column differentiates them.
--
-- REV-R-C (owner=workspace_slug convention, documented here so future migrations preserve it):
--   For Bitbucket rows, both `owner` and `workspace` are populated with the workspace slug
--   (consistent dual-write). The dual-filter queries `(workspace = $X AND owner = $Y)` used by
--   `supersedeOlderJobs` and `mostRecentJobForPullRequest` therefore match uniformly -- divergence
--   between the two columns would silently break supersede + dedup, so the convention is mandated
--   here at the schema boundary.
--
-- House style: 003 (ADD COLUMN IF NOT EXISTS + pg_constraint guard) and 004 (CREATE INDEX IF NOT
-- EXISTS + CREATE TABLE IF NOT EXISTS) are the precedents. Every additive shape here mirrors one of
-- those, and the DO $$ ... information_schema guard is the canonical pattern for conditional DDL
-- this codebase reserves for non-CREATE-TYPE statements (review finding 8 / Pitfall 4).

ALTER TABLE repositories ADD COLUMN IF NOT EXISTS workspace TEXT;

-- REV-M-3: PostgreSQL has no `IF NOT NULL` for `DROP NOT NULL`, so the existence guard goes inside
-- a DO $$ block. The `is_nullable='NO'` predicate short-circuits on re-run once the column is
-- already nullable -- a clean no-op on the second apply. Mirrors the pg_constraint guard from
-- 003_vcs_provider_foundation.sql:25-32 in spirit (existence-check first, DDL only when absent).
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'repositories'
      AND column_name = 'installation_id'
      AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE repositories ALTER COLUMN installation_id DROP NOT NULL;
  END IF;
END $$;

-- Canonical Bitbucket identity UNIQUE (D-01 / REV-C-1). Guarded with the pg_constraint-existence
-- check from 003:25-32 -- the guard's conname check and the ADD CONSTRAINT name below MUST stay
-- byte-identical; any divergence would make the guard silently no-op or raise a duplicate-
-- constraint error on re-run.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'repositories_vcs_provider_workspace_repo_key'
  ) THEN
    ALTER TABLE repositories
      ADD CONSTRAINT repositories_vcs_provider_workspace_repo_key UNIQUE (vcs_provider, workspace, repo);
  END IF;
END $$;

-- Non-unique provider-less prefix lookup index for the webhook route's identity resolution
-- (D-03 / Phase 6 add-repo path). `IF NOT EXISTS` keeps it re-run safe.
CREATE INDEX IF NOT EXISTS idx_repositories_workspace_repo ON repositories (workspace, repo);