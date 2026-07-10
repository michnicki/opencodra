-- Job lifecycle (workflow tracking, continuation counting, cancelled/stopped statuses),
-- global settings, async batch review support, and model config cleanup.
-- Combines former migrations 002-009.
-- All statements are idempotent so databases that already applied any of the
-- original files (tracked by filename in schema_migrations) can re-run this safely.

-- (002) Link jobs to their Cloudflare Workflow instance.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS workflow_instance_id UUID;
CREATE INDEX IF NOT EXISTS idx_jobs_workflow_instance_id ON jobs(workflow_instance_id);

-- (003) Key/value store for instance-wide settings.
CREATE TABLE IF NOT EXISTS global_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- (004) Default review performance settings.
INSERT INTO global_settings (key, value) VALUES
  ('review_concurrency_level', 'medium'),
  ('review_max_comments', '10')
ON CONFLICT (key) DO NOTHING;

-- (005) Rate-limit columns moved out of model_configs.
ALTER TABLE model_configs DROP COLUMN IF EXISTS rpm;
ALTER TABLE model_configs DROP COLUMN IF EXISTS tpm;
ALTER TABLE model_configs DROP COLUMN IF EXISTS rpd;

-- (006) Tracks how many times a job has rescheduled the *same* phase without completing any
-- file review (a "no-progress continuation"). Reset to 0 whenever a chunk makes progress.
-- A hard ceiling on this counter (see MAX_JOB_CONTINUATIONS in review.ts) stops a job that
-- can never make headway from churning indefinitely on transient/budget deferrals.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS continuation_count INT NOT NULL DEFAULT 0;

-- (007) Supports the Workers AI asynchronous Batch API path (see submitCloudflareBatch/pollCloudflareBatch).
-- A file review submitted to the async queue is persisted with file_status = 'pending' plus the
-- queue request_id, so a later review-phase invocation can poll for the result across invocations
-- (decoupling long/reasoning-model inference from any single invocation's timeout & subrequest cap).
-- Both columns are cleared once the batch completes and the review is persisted as 'done'/'failed'.
ALTER TABLE file_reviews ADD COLUMN IF NOT EXISTS async_request_id TEXT;
ALTER TABLE file_reviews ADD COLUMN IF NOT EXISTS async_model TEXT;

-- (008 + 009) Widen the job status CHECK to allow the terminal 'cancelled' status (user
-- explicitly stops a job via the /stop endpoint — distinct from 'failed' and 'superseded')
-- and the terminal 'stopped' status (nothing writes it yet; reserved for an upcoming stop
-- flow). The status column is TEXT + CHECK (not a native enum), so we just widen the CHECK.
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_status_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_status_check
  CHECK (status IN ('queued', 'running', 'done', 'failed', 'superseded', 'cancelled', 'stopped'));
