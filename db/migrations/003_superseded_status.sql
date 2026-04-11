-- Add 'superseded' to the jobs status check constraint
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_status_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_status_check CHECK (status IN ('queued', 'running', 'done', 'failed', 'superseded'));
