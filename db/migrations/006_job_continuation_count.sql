-- Tracks how many times a job has rescheduled the *same* phase without completing any
-- file review (a "no-progress continuation"). Reset to 0 whenever a chunk makes progress.
-- A hard ceiling on this counter (see MAX_JOB_CONTINUATIONS in review.ts) stops a job that
-- can never make headway from churning indefinitely on transient/budget deferrals.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS continuation_count INT NOT NULL DEFAULT 0;
