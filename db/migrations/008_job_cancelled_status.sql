-- Adds a terminal 'cancelled' status for jobs that a user explicitly stops (see the /stop
-- endpoint). Distinct from 'failed' (nothing went wrong) and 'superseded' (replaced by a newer
-- job). The status column is TEXT + CHECK (not the native enum), so we just widen the CHECK.
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_status_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_status_check
  CHECK (status IN ('queued', 'running', 'done', 'failed', 'superseded', 'cancelled'));
