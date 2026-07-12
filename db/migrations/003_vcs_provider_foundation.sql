-- FND-01: repositories must be able to represent either VCS provider (github|bitbucket).
-- TEXT + CHECK, not a native Postgres ENUM, matching the jobs.status/verdict/trigger precedent
-- in 001_initial.sql (D-01) -- ENUMs require ALTER TYPE ... ADD VALUE for future providers, which
-- cannot run inside a transaction block alongside other DDL; TEXT+CHECK stays consistent with the
-- rest of this schema and is trivially extended by a follow-up migration.
-- The DEFAULT alone backfills every existing row as 'github' as part of this ADD COLUMN statement --
-- no separate UPDATE/backfill statement is added (D-07): a live pg_constraint query against
-- TEST_DATABASE_URL was run before writing this file to confirm the pre-existing unique constraint
-- name below, so this migration performs no backfill.
ALTER TABLE repositories
  ADD COLUMN IF NOT EXISTS vcs_provider TEXT NOT NULL DEFAULT 'github' CHECK (vcs_provider IN ('github', 'bitbucket'));

-- The inline `UNIQUE(owner, repo)` from 001_initial.sql (line 32) must be replaced with
-- `UNIQUE(vcs_provider, owner, repo)` so a bitbucket repository can share an owner/repo pair with
-- an existing github row (FND-01 success criterion 2). The dropped constraint's name was confirmed
-- live via `SELECT conname FROM pg_constraint WHERE conrelid = 'repositories'::regclass AND contype = 'u'`
-- against TEST_DATABASE_URL (not assumed from source inference alone) -- confirmed: repositories_owner_repo_key.
ALTER TABLE repositories DROP CONSTRAINT IF EXISTS repositories_owner_repo_key;

-- Guarded with the pg_constraint-existence-check idiom (not `DO $$ ... EXCEPTION WHEN duplicate_object`,
-- which this codebase reserves exclusively for `CREATE TYPE`), so re-running this migration is a no-op
-- once the constraint exists. The guard's conname check and the ADD CONSTRAINT name below must stay
-- byte-identical -- any divergence would make the guard silently no-op or raise a duplicate-constraint
-- error on re-run.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'repositories_vcs_provider_owner_repo_key'
  ) THEN
    ALTER TABLE repositories
      ADD CONSTRAINT repositories_vcs_provider_owner_repo_key UNIQUE (vcs_provider, owner, repo);
  END IF;
END $$;

-- FND-02: jobs needs provider-neutral references to the posted check/status and review objects.
-- Nullable TEXT, added alongside (not replacing) the existing BIGINT check_run_id/review_id columns,
-- which remain canonical for GitHub and are read unmodified by existing code (D-02, D-05). Bitbucket's
-- Code Insights report key / PR comment reference is not a BIGINT, hence the separate TEXT columns
-- rather than widening the existing ones.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS status_check_ref TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS review_ref TEXT;
