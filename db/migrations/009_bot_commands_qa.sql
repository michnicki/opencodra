-- Phase 11 (v1.1 Interactive Multi-Pass Review) / bot-commands-pr-q-a: provision the additive,
-- re-run-safe storage substrate for in-PR bot commands + Q&A. EVERY change here is INERT for the
-- existing review pipeline (NREG-01) -- both tables are created EMPTY with no writer, and the two new
-- `jobs` columns are NULLABLE with no writer, until later Phase 11 plans wire the consumers. Nothing
-- in this migration changes runtime behavior for a GitHub or Bitbucket review that runs today.
-- Additive and re-run safe: only IF [NOT] EXISTS / existence-guarded verbs -- no drop, rename,
-- backfill, or destructive rewrite. Applied under the advisory lock in a single BEGIN/COMMIT by
-- scripts/migrate.mjs (schema_migrations tracked). The highest previously-applied migration is 008.
-- Re-run safety is TESTED by test/migration-009-idempotency.spec.ts (raw SQL executed twice), not
-- merely asserted.

-- 1. skipped_files (D-10 skipped-for-size bookkeeping, CMD-02): records which files a full review
--    omitted for size so a later `review-rest` job can re-review exactly those paths. Created EMPTY --
--    the prepare-phase producer is wired in a later Phase 11 plan.
--
--    KEY DESIGN (REVIEW: Codex 11-01 HIGH / OpenCode 11-05): the table carries the full PR identity
--    (vcs_provider, workspace, repo_slug, pr_number) + head_sha. `review-rest` runs as a NEW job, so
--    it cannot find the original full-review job's skips by job_id -- listSkippedFilesForHead queries
--    by PR identity + the CURRENT head_sha across ANY job. job_id is retained for provenance (and
--    ON DELETE CASCADE cleanup), and UNIQUE(job_id, file_path) still prevents intra-job duplicate
--    inserts on an idempotent re-run. head_sha is stored as BYTEA (SHAs are bytes, mirroring
--    jobs.commit_sha / bytesToHex).
CREATE TABLE IF NOT EXISTS skipped_files (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id       UUID        NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  vcs_provider TEXT        NOT NULL,
  workspace    TEXT        NOT NULL,
  repo_slug    TEXT        NOT NULL,
  pr_number    INTEGER     NOT NULL,
  head_sha     BYTEA       NOT NULL,
  file_path    TEXT        NOT NULL,
  reason       TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_id, file_path)
);

-- The lookup index for listSkippedFilesForHead: a new review-rest job finds the original job's skips
-- for the current head via (vcs_provider, workspace, repo_slug, pr_number, head_sha).
CREATE INDEX IF NOT EXISTS skipped_files_pr_head_idx
  ON skipped_files (vcs_provider, workspace, repo_slug, pr_number, head_sha);

-- 2. reject_feedback (D-09 reject capture, CMD-05, capture-only -> feeds v2 LRN-01): records a
--    structured negative-feedback signal when a user replies `reject` under an inline finding. Created
--    EMPTY -- the command dispatcher writer is wired in a later Phase 11 plan.
--
--    rejected_by stores the actor's IMMUTABLE account_id / numeric id (NREG-02), never a mutable
--    username/handle. finding_ref is the opaque provider ref of the finding being rejected.
--    source_comment_ref is the opaque ref of the REPLY comment that carried the reject; the
--    UNIQUE(vcs_provider, source_comment_ref) makes capture idempotent so a Worker crash-before-ack
--    queue replay does NOT double-insert the same reject signal (REVIEW: Codex 11-01 MED).
CREATE TABLE IF NOT EXISTS reject_feedback (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  vcs_provider       TEXT        NOT NULL,
  workspace          TEXT        NOT NULL,
  repo_slug          TEXT        NOT NULL,
  pr_number          INTEGER     NOT NULL,
  finding_ref        TEXT        NOT NULL,
  reason             TEXT,
  rejected_by        TEXT        NOT NULL,
  source_comment_ref TEXT        NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (vcs_provider, source_comment_ref)
);

-- 3. jobs.review_scope / jobs.scope_source_job_id (REVIEW: Codex 11-05 HIGH): durable review-rest
--    scope. A review-rest run must survive fresh-instance handoff + lease recovery, which drop the
--    transient queue message -- so the scope lives on the PERSISTED job row instead. Both NULLABLE
--    with no default and NOT backfilled, so every existing job row is unchanged and every existing
--    insert reads them back as NULL (behaviorally inert, NREG-01). review_scope mirrors the
--    reviewJobMessageSchema.reviewScope enum ('all'|'rest'|'head'); scope_source_job_id links a
--    review-rest job back to the original full-review job whose skips it re-reviews.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS review_scope TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS scope_source_job_id UUID;
