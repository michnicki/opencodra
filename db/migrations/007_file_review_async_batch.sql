-- Supports the Workers AI asynchronous Batch API path (see submitCloudflareBatch/pollCloudflareBatch).
-- A file review submitted to the async queue is persisted with file_status = 'pending' plus the
-- queue request_id, so a later review-phase invocation can poll for the result across invocations
-- (decoupling long/reasoning-model inference from any single invocation's timeout & subrequest cap).
-- Both columns are cleared once the batch completes and the review is persisted as 'done'/'failed'.
ALTER TABLE file_reviews ADD COLUMN IF NOT EXISTS async_request_id TEXT;
ALTER TABLE file_reviews ADD COLUMN IF NOT EXISTS async_model TEXT;
