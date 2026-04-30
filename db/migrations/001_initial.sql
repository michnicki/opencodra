CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
    CREATE TYPE job_trigger AS ENUM ('auto', 'mention', 'retry');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE job_status AS ENUM ('queued', 'running', 'done', 'failed', 'superseded');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE job_verdict AS ENUM ('approve', 'comment');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE file_status_enum AS ENUM ('pending', 'done', 'skipped', 'failed');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- POINT 3: Data Normalization (Lookup Tables)
CREATE TABLE IF NOT EXISTS repositories (
  -- 8-byte
  installation_id BIGINT NOT NULL,
  -- 4-byte
  id              SERIAL PRIMARY KEY,
  -- Variable
  owner           TEXT   NOT NULL,
  repo            TEXT   NOT NULL,
  UNIQUE(owner, repo)
);
CREATE INDEX IF NOT EXISTS repositories_owner_idx ON repositories(owner);

CREATE TABLE IF NOT EXISTS jobs (
  -- 16-byte fixed size
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  retry_of_job_id          UUID        REFERENCES jobs(id) ON DELETE SET NULL,

  -- 8-byte fixed size
  check_run_id             BIGINT,
  review_id                BIGINT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at               TIMESTAMPTZ,
  finished_at              TIMESTAMPTZ,

  -- 4-byte fixed size
  repository_id            INTEGER     NOT NULL REFERENCES repositories(id),
  pr_number                INTEGER     NOT NULL,
  total_input_tokens       INTEGER     DEFAULT 0,
  total_output_tokens      INTEGER     DEFAULT 0,
  file_count               INTEGER     DEFAULT 0,
  comment_count            INTEGER     DEFAULT 0,
  overall_confidence_score REAL,

  -- POINT 1: Store Git SHAs as raw Binary (BYTEA)
  commit_sha               BYTEA       NOT NULL,
  base_sha                 BYTEA       NOT NULL,

  -- Variable length text, JSONB
  trigger                  TEXT        NOT NULL CHECK (trigger IN ('auto', 'mention', 'retry')),
  status                   TEXT        NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed', 'superseded')),
  verdict                  TEXT        CHECK (verdict IN ('approve', 'comment')),
  pr_title                 TEXT,
  pr_author                TEXT,
  head_ref                 TEXT,
  base_ref                 TEXT,
  summary_model            TEXT,
  overall_correctness      TEXT,
  error_msg                TEXT,
  summary_markdown         TEXT,
  config_snapshot          JSONB       COMPRESSION lz4,
  steps                    JSONB       COMPRESSION lz4 DEFAULT '[]'::jsonb
) WITH (fillfactor = 90);

CREATE INDEX IF NOT EXISTS jobs_repo_idx ON jobs (repository_id, pr_number);
CREATE INDEX IF NOT EXISTS jobs_active_idx ON jobs (status) WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS jobs_created_idx ON jobs USING brin (created_at);
CREATE INDEX IF NOT EXISTS jobs_head_sha_idx ON jobs (repository_id, pr_number, commit_sha, trigger);
CREATE INDEX IF NOT EXISTS jobs_correctness_idx ON jobs (overall_correctness);

CREATE TABLE IF NOT EXISTS file_reviews (
  -- 16-byte
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id              UUID        NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,

  -- 8-byte
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- 4-byte
  diff_line_count     INTEGER,
  input_tokens        INTEGER,
  output_tokens       INTEGER,
  duration_ms         INTEGER,
  confidence_score    REAL,

  -- Variable length
  file_status         TEXT        NOT NULL CHECK (file_status IN ('pending', 'done', 'skipped', 'failed')),
  verdict             TEXT        CHECK (verdict IN ('approve', 'comment')),
  file_path           TEXT        NOT NULL,
  model_used          TEXT        NOT NULL,
  model_provider      TEXT,
  overall_correctness TEXT,
  file_summary        TEXT,
  error_msg           TEXT,
  diff_input          TEXT        COMPRESSION lz4,
  raw_ai_output       TEXT        COMPRESSION lz4
) WITH (fillfactor = 90);

CREATE INDEX IF NOT EXISTS file_reviews_job_idx ON file_reviews (job_id);
CREATE INDEX IF NOT EXISTS file_reviews_correctness_idx ON file_reviews (overall_correctness);
CREATE INDEX IF NOT EXISTS file_reviews_provider_idx ON file_reviews (model_provider);

-- POINT 4: Flatten JSONB into a table
CREATE TABLE IF NOT EXISTS review_comments (
  -- 16-byte
  file_review_id   UUID    NOT NULL REFERENCES file_reviews(id) ON DELETE CASCADE,
  -- 8-byte
  id               BIGSERIAL PRIMARY KEY,
  -- 4-byte
  line             INTEGER,
  position         INTEGER,
  -- Variable length
  path             TEXT    NOT NULL,
  severity         TEXT    NOT NULL,
  category         TEXT    NOT NULL DEFAULT 'quality',
  title            TEXT    NOT NULL,
  body             TEXT    COMPRESSION lz4 NOT NULL,
  code_suggestion  TEXT    COMPRESSION lz4
);
CREATE INDEX IF NOT EXISTS review_comments_file_idx ON review_comments(file_review_id);

CREATE TABLE IF NOT EXISTS repo_configs (
  -- 16-byte
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 8-byte
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- 4-byte
  repository_id   INTEGER     NOT NULL REFERENCES repositories(id),

  -- 1-byte
  enabled         BOOLEAN     NOT NULL DEFAULT TRUE,

  -- Variable length
  main_model      TEXT,
  parsed_json     JSONB,
  fallback_models JSONB       DEFAULT '[]'::jsonb,
  size_overrides  JSONB,
  UNIQUE (repository_id)
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  -- 16-byte
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 8-byte
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- 4-byte
  repository_id INTEGER     REFERENCES repositories(id),

  -- Variable length
  delivery_id   TEXT        NOT NULL UNIQUE,
  event_name    TEXT        NOT NULL,
  payload       JSONB       COMPRESSION lz4 NOT NULL
);

CREATE INDEX IF NOT EXISTS webhook_deliveries_repo_idx ON webhook_deliveries (repository_id, received_at DESC);

CREATE TABLE IF NOT EXISTS model_configs (
  -- 8-byte
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),

  -- 4-byte
  rpm        INTEGER NOT NULL,
  tpm        INTEGER NOT NULL,
  rpd        INTEGER NOT NULL,

  -- Variable length
  model_id   TEXT PRIMARY KEY,
  provider   TEXT NOT NULL
);

INSERT INTO model_configs (model_id, rpm, tpm, rpd, provider)
VALUES
  ('gemma-4-31b-it',               15, 1000000, 1500, 'google'),
  ('gemma-4-26b-a4b-it',           30, 1000000, 1500, 'google'),
  ('@cf/moonshotai/kimi-k2.5',     10,  131072,  300, 'cloudflare'),
  ('@cf/zai-org/glm-4.7-flash',    20,  131072,  600, 'cloudflare')
ON CONFLICT (model_id) DO UPDATE SET
  rpm = EXCLUDED.rpm,
  tpm = EXCLUDED.tpm,
  rpd = EXCLUDED.rpd,
  provider = EXCLUDED.provider,
  updated_at = now();
