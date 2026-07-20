-- Phase 7 (v1.1 Interactive Multi-Pass Review) / schema-contract-foundation: provision the additive,
-- re-run-safe storage substrate that later phases build on. EVERY change here is INERT for the
-- existing review pipeline -- `file_reviews.pass` defaults 'main' (so existing rows and every existing
-- main-pass insert/upsert are byte-identical), the two new `jobs` columns are NULLABLE and NOT
-- backfilled, and `pr_review_state` is created EMPTY. Nothing in this migration changes runtime
-- behavior for a GitHub or Bitbucket review that runs today; it only makes the Phase 9/10/11 features
-- POSSIBLE (D-01/D-02/D-07). Additive and re-run safe: only IF [NOT] EXISTS / existence-guarded verbs;
-- no drop, rename, backfill, or destructive rewrite. Applied under advisory lock 93741624 in a single
-- BEGIN/COMMIT by scripts/migrate.mjs (schema_migrations tracked). Re-run safety is TESTED by
-- test/migration-007-idempotency.spec.ts (raw SQL executed twice), not merely asserted (T-07-03).

-- 1. pr_review_state (D-01/D-02): DB-backed, provider-agnostic pause storage for Phase 11's
--    "pause/resume this PR's review" directive. Created EMPTY -- a row is inserted lazily the first
--    time a PR is paused (one row per PR, lazy). PAUSE-ONLY: there is deliberately NO `ignored`
--    column -- the ignore-in-PR-body directive is re-parsed statelessly each webhook in Phase 11
--    (D-02), so it needs no persisted state.
--
--    workspace is NOT NULL (Codex HIGH #2): this is DELIBERATELY the OPPOSITE of the `repositories`
--    table, which leaves workspace NULL for GitHub rows (repositories.ts:53). pr_review_state instead
--    stores a canonical per-provider value in workspace -- GitHub -> repo owner/login, Bitbucket ->
--    workspace slug -- because (a) Postgres treats NULLs as DISTINCT under a default UNIQUE, so a
--    nullable workspace would let GitHub insert unlimited duplicate rows for the same PR and break
--    D-01's one-row-per-PR invariant, and (b) an equality lookup `workspace = $N` must never hit a
--    NULL. Phase 11's writer MUST supply this canonical value (owner for GitHub, workspace slug for
--    Bitbucket). Since the table is brand-new and empty, NOT NULL needs no backfill.
--
--    paused_by stores the actor's IMMUTABLE account_id (NREG-02), never a mutable username/handle.
CREATE TABLE IF NOT EXISTS pr_review_state (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  vcs_provider TEXT        NOT NULL,
  workspace    TEXT        NOT NULL,
  repo_slug    TEXT        NOT NULL,
  pr_number    INTEGER     NOT NULL,
  paused       BOOLEAN     NOT NULL DEFAULT false,
  paused_by    TEXT,
  paused_at    TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (vcs_provider, workspace, repo_slug, pr_number)
);

-- 2. file_reviews.pass (D-07): tags each per-file review row with the review pass that produced it.
--    Defaults 'main' so every existing row and every existing insert is inert (they are all the
--    'main' pass). Phase 10 introduces 'security'-pass rows to make (file, pass) work-units possible
--    without touching any budget constant. NOT NULL + DEFAULT 'main' means no backfill is needed --
--    the default materializes on every existing row at ALTER time.
ALTER TABLE file_reviews ADD COLUMN IF NOT EXISTS pass TEXT NOT NULL DEFAULT 'main';

-- MANDATORY CHECK (both reviewers): lock the value-set at the DB layer to match fileReviewPassSchema
-- (Plan 01, z.enum(['main','security'])). Guarded with the migration-005 pg_constraint existence
-- pattern (Postgres has no `ADD CONSTRAINT IF NOT EXISTS`), so it is a clean no-op on re-run. The
-- guard's conname and the ADD CONSTRAINT name below MUST stay byte-identical.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'file_reviews_pass_check'
  ) THEN
    ALTER TABLE file_reviews
      ADD CONSTRAINT file_reviews_pass_check CHECK (pass IN ('main', 'security'));
  END IF;
END $$;

-- 3. EXPAND/CONTRACT (Codex HIGH #1 -- migrate-before-deploy): CREATE the new 3-column unique index
--    that is the ON CONFLICT arbiter for the four upsert/inherit/bulk-fail sites in file-reviews.ts.
--    The OLD `file_reviews_job_file_path_key` (job_id, file_path) index from 001_initial.sql:528 is
--    INTENTIONALLY RETAINED this phase -- it is NOT dropped here. Codra deploys `build -> migrate ->
--    wrangler deploy` (package.json), so 007 runs BEFORE the new Worker is published; the still-running
--    OLD Worker (and any in-flight/hibernating Workflow) executing `ON CONFLICT (job_id, file_path)`
--    during that window needs a matching arbiter or Postgres throws "no unique or exclusion constraint
--    matching the ON CONFLICT specification". While `pass` is always 'main', both unique indexes are
--    semantically equivalent and coexist safely (a main-pass upsert conflicts on the 3-col arbiter ->
--    DO UPDATE in place -> no second row -> the 2-col unique stays satisfied). DEFERRED TO PHASE 10:
--    Phase 10 DROPs file_reviews_job_file_path_key immediately before enabling 'security'-pass rows,
--    since a second row for the same file at a different pass would otherwise violate the old 2-col
--    unique.
CREATE UNIQUE INDEX IF NOT EXISTS file_reviews_job_file_path_pass_key
  ON file_reviews (job_id, file_path, pass);

-- 4. jobs.walkthrough_comment_ref / jobs.critic_result (Pattern 5, status_check_ref precedent):
--    durable state for the Phase 9 walkthrough comment and the Phase 10 critic result. Both NULLABLE
--    and NOT backfilled -- an existing job simply has NULL for each until a later phase writes it, so
--    the columns are inert today.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS walkthrough_comment_ref TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS critic_result JSONB;
