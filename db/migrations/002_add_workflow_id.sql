ALTER TABLE jobs ADD COLUMN workflow_instance_id UUID;
CREATE INDEX IF NOT EXISTS idx_jobs_workflow_instance_id ON jobs(workflow_instance_id);
