-- Normalize databases that already applied the original 001_initial.sql.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS repositories (
  installation_id BIGINT NOT NULL,
  id              SERIAL PRIMARY KEY,
  owner           TEXT   NOT NULL,
  repo            TEXT   NOT NULL,
  UNIQUE(owner, repo)
);

CREATE INDEX IF NOT EXISTS repositories_owner_idx ON repositories(owner);

CREATE TABLE IF NOT EXISTS review_comments (
  file_review_id   UUID    NOT NULL REFERENCES file_reviews(id) ON DELETE CASCADE,
  id               BIGSERIAL PRIMARY KEY,
  line             INTEGER,
  position         INTEGER,
  path             TEXT    NOT NULL,
  severity         TEXT    NOT NULL,
  category         TEXT    NOT NULL DEFAULT 'quality',
  title            TEXT    NOT NULL,
  body             TEXT    COMPRESSION lz4 NOT NULL,
  code_suggestion  TEXT    COMPRESSION lz4
);

CREATE INDEX IF NOT EXISTS review_comments_file_idx ON review_comments(file_review_id);

DO $$
DECLARE
  has_old_job_repo_columns BOOLEAN;
  has_old_repo_config_columns BOOLEAN;
  has_old_webhook_repo_columns BOOLEAN;
  commit_sha_type TEXT;
  base_sha_type TEXT;
  null_repository_jobs INTEGER;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'jobs'
      AND column_name IN ('installation_id', 'owner', 'repo')
    GROUP BY table_name
    HAVING COUNT(*) = 3
  ) INTO has_old_job_repo_columns;

  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'repo_configs'
      AND column_name IN ('installation_id', 'owner', 'repo')
    GROUP BY table_name
    HAVING COUNT(*) = 3
  ) INTO has_old_repo_config_columns;

  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'webhook_deliveries'
      AND column_name IN ('owner', 'repo')
    GROUP BY table_name
    HAVING COUNT(*) = 2
  ) INTO has_old_webhook_repo_columns;

  IF has_old_job_repo_columns THEN
    EXECUTE '
      INSERT INTO repositories (installation_id, owner, repo)
      SELECT DISTINCT
        CASE WHEN installation_id ~ ''^[0-9]+$'' THEN installation_id::bigint ELSE 0 END,
        owner,
        repo
      FROM jobs
      WHERE installation_id IS NOT NULL
        AND owner IS NOT NULL
        AND repo IS NOT NULL
      ON CONFLICT (owner, repo) DO UPDATE
      SET installation_id = EXCLUDED.installation_id
    ';
  END IF;

  IF has_old_repo_config_columns THEN
    EXECUTE '
      INSERT INTO repositories (installation_id, owner, repo)
      SELECT DISTINCT
        CASE WHEN installation_id ~ ''^[0-9]+$'' THEN installation_id::bigint ELSE 0 END,
        owner,
        repo
      FROM repo_configs
      WHERE installation_id IS NOT NULL
        AND owner IS NOT NULL
        AND repo IS NOT NULL
      ON CONFLICT (owner, repo) DO UPDATE
      SET installation_id = EXCLUDED.installation_id
    ';
  END IF;

  ALTER TABLE jobs ADD COLUMN IF NOT EXISTS repository_id INTEGER;

  IF has_old_job_repo_columns THEN
    EXECUTE '
      UPDATE jobs j
      SET repository_id = r.id
      FROM repositories r
      WHERE j.repository_id IS NULL
        AND r.owner = j.owner
        AND r.repo = j.repo
    ';
  END IF;

  SELECT data_type
  INTO commit_sha_type
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'jobs'
    AND column_name = 'commit_sha';

  IF commit_sha_type IS NOT NULL AND commit_sha_type <> 'bytea' THEN
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS commit_sha_bytea BYTEA;
    EXECUTE '
      UPDATE jobs
      SET commit_sha_bytea = CASE
        WHEN commit_sha ~ ''^[0-9a-fA-F]+$'' AND length(commit_sha) % 2 = 0 THEN decode(commit_sha, ''hex'')
        ELSE convert_to(commit_sha, ''UTF8'')
      END
      WHERE commit_sha_bytea IS NULL
    ';
    ALTER TABLE jobs DROP COLUMN commit_sha;
    ALTER TABLE jobs RENAME COLUMN commit_sha_bytea TO commit_sha;
  END IF;

  SELECT data_type
  INTO base_sha_type
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'jobs'
    AND column_name = 'base_sha';

  IF base_sha_type IS NOT NULL AND base_sha_type <> 'bytea' THEN
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS base_sha_bytea BYTEA;
    EXECUTE '
      UPDATE jobs
      SET base_sha_bytea = CASE
        WHEN base_sha ~ ''^[0-9a-fA-F]+$'' AND length(base_sha) % 2 = 0 THEN decode(base_sha, ''hex'')
        ELSE convert_to(base_sha, ''UTF8'')
      END
      WHERE base_sha_bytea IS NULL
    ';
    ALTER TABLE jobs DROP COLUMN base_sha;
    ALTER TABLE jobs RENAME COLUMN base_sha_bytea TO base_sha;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'jobs_repository_id_fkey'
  ) THEN
    ALTER TABLE jobs
      ADD CONSTRAINT jobs_repository_id_fkey
      FOREIGN KEY (repository_id) REFERENCES repositories(id);
  END IF;

  SELECT COUNT(*) INTO null_repository_jobs FROM jobs WHERE repository_id IS NULL;
  IF null_repository_jobs = 0 THEN
    ALTER TABLE jobs ALTER COLUMN repository_id SET NOT NULL;
  END IF;

  DROP INDEX IF EXISTS jobs_repo_idx;
  DROP INDEX IF EXISTS jobs_status_idx;
  DROP INDEX IF EXISTS jobs_created_idx;
  DROP INDEX IF EXISTS jobs_head_sha_idx;

  CREATE INDEX IF NOT EXISTS jobs_repo_idx ON jobs (repository_id, pr_number);
  CREATE INDEX IF NOT EXISTS jobs_active_idx ON jobs (status) WHERE status IN ('queued', 'running');
  CREATE INDEX IF NOT EXISTS jobs_created_idx ON jobs USING brin (created_at);
  CREATE INDEX IF NOT EXISTS jobs_head_sha_idx ON jobs (repository_id, pr_number, commit_sha, trigger);

  IF has_old_job_repo_columns THEN
    ALTER TABLE jobs DROP COLUMN IF EXISTS installation_id;
    ALTER TABLE jobs DROP COLUMN IF EXISTS owner;
    ALTER TABLE jobs DROP COLUMN IF EXISTS repo;
  END IF;
END $$;

DO $$
DECLARE
  has_old_columns BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'repo_configs'
      AND column_name IN ('installation_id', 'owner', 'repo')
    GROUP BY table_name
    HAVING COUNT(*) = 3
  ) INTO has_old_columns;

  ALTER TABLE repo_configs ADD COLUMN IF NOT EXISTS repository_id INTEGER;

  IF has_old_columns THEN
    EXECUTE '
      UPDATE repo_configs rc
      SET repository_id = r.id
      FROM repositories r
      WHERE rc.repository_id IS NULL
        AND r.owner = rc.owner
        AND r.repo = rc.repo
    ';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'repo_configs_repository_id_fkey'
  ) THEN
    ALTER TABLE repo_configs
      ADD CONSTRAINT repo_configs_repository_id_fkey
      FOREIGN KEY (repository_id) REFERENCES repositories(id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'repo_configs_repository_id_key'
  ) THEN
    ALTER TABLE repo_configs ADD CONSTRAINT repo_configs_repository_id_key UNIQUE (repository_id);
  END IF;

  ALTER TABLE repo_configs DROP CONSTRAINT IF EXISTS repo_configs_owner_repo_key;
  ALTER TABLE repo_configs DROP COLUMN IF EXISTS installation_id;
  ALTER TABLE repo_configs DROP COLUMN IF EXISTS owner;
  ALTER TABLE repo_configs DROP COLUMN IF EXISTS repo;
  ALTER TABLE repo_configs DROP COLUMN IF EXISTS raw_yaml;
  ALTER TABLE repo_configs DROP COLUMN IF EXISTS config_missing;
END $$;

DO $$
DECLARE
  has_old_columns BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'webhook_deliveries'
      AND column_name IN ('owner', 'repo')
    GROUP BY table_name
    HAVING COUNT(*) = 2
  ) INTO has_old_columns;

  ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS repository_id INTEGER;

  IF has_old_columns THEN
    EXECUTE '
      UPDATE webhook_deliveries wd
      SET repository_id = r.id
      FROM repositories r
      WHERE wd.repository_id IS NULL
        AND r.owner = wd.owner
        AND r.repo = wd.repo
    ';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'webhook_deliveries_repository_id_fkey'
  ) THEN
    ALTER TABLE webhook_deliveries
      ADD CONSTRAINT webhook_deliveries_repository_id_fkey
      FOREIGN KEY (repository_id) REFERENCES repositories(id);
  END IF;

  DROP INDEX IF EXISTS webhook_deliveries_repo_idx;
  CREATE INDEX IF NOT EXISTS webhook_deliveries_repo_idx ON webhook_deliveries (repository_id, received_at DESC);

  ALTER TABLE webhook_deliveries DROP COLUMN IF EXISTS owner;
  ALTER TABLE webhook_deliveries DROP COLUMN IF EXISTS repo;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'file_reviews'
      AND column_name = 'parsed_comments'
  ) THEN
    INSERT INTO review_comments (
      file_review_id,
      path,
      line,
      position,
      severity,
      category,
      title,
      body,
      code_suggestion
    )
    SELECT
      fr.id,
      COALESCE(comment->>'path', fr.file_path),
      NULLIF(comment->>'line', '')::int,
      NULLIF(comment->>'position', '')::int,
      COALESCE(comment->>'severity', 'P3'),
      COALESCE(comment->>'category', 'quality'),
      COALESCE(comment->>'title', 'Code finding'),
      COALESCE(comment->>'body', ''),
      comment->>'codeSuggestion'
    FROM file_reviews fr
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(fr.parsed_comments, '[]'::jsonb)) AS comment
    WHERE NOT EXISTS (
      SELECT 1 FROM review_comments rc WHERE rc.file_review_id = fr.id
    );

    ALTER TABLE file_reviews DROP COLUMN parsed_comments;
  END IF;
END $$;
