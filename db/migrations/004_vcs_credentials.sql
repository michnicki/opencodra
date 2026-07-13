-- AUTH-02/AUTH-03: dedicated storage for VCS bot credentials (Bitbucket bot access token +
-- per-repo webhook secret). This is a SEPARATE table from `repositories` on purpose (D-02):
-- `repositories.installation_id` is NOT NULL (see 001_initial.sql:28 / src/server/db/repositories.ts),
-- and a Bitbucket repo has no installation_id and no `repositories` row until Phase 6. Credentials
-- therefore key on text identity (vcs_provider, workspace, repo_slug) -- exactly the tuple Phase 5's
-- webhook route resolves from the payload before verifying. There is deliberately NO foreign key to
-- `repositories` and this migration does not touch `installation_id` (D-02).
--
-- This table stores ONLY the bot access token + per-repo webhook secret, both as ciphertext
-- (encrypted_* columns, AES-GCM via LLM_CONFIG_ENCRYPTION_KEY in src/server/core/crypto.ts). It never
-- stores the dashboard-login OAuth consumer credential, which is separate storage owned by Phase 6
-- and must never be conflated with the bot token (D-15).
--
-- `CREATE TABLE IF NOT EXISTS` keeps this migration re-run safe under the advisory lock in
-- scripts/migrate.mjs (Pitfall 4). vcs_provider uses TEXT + CHECK rather than a native ENUM, matching
-- the jobs.status / repositories.vcs_provider precedent (D-01) -- ENUMs need ALTER TYPE ... ADD VALUE
-- for a future provider, which cannot run in a transaction block alongside other DDL.
CREATE TABLE IF NOT EXISTS vcs_credentials (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  vcs_provider             TEXT        NOT NULL CHECK (vcs_provider IN ('github', 'bitbucket')),
  workspace                TEXT        NOT NULL,
  repo_slug                TEXT        NOT NULL,
  -- Secrets at rest: ciphertext only (D-10 / T-04-01, T-04-05). Nullable so a credential row can
  -- exist with one secret rotated/cleared independently of the other.
  encrypted_access_token   TEXT,
  encrypted_webhook_secret TEXT,
  -- Nullable: NULL means "no expiry recorded" (D-04). Server computes the four-state status from
  -- this value (src/server/db/vcs-credentials.ts::computeCredentialStatus); no live Bitbucket call.
  token_expires_at         TIMESTAMPTZ,
  label                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The upsert key (D-03 / D-11): UNIQUE (vcs_provider, workspace, repo_slug) is what makes
-- upsertVcsCredential a rotate-in-place `INSERT ... ON CONFLICT DO UPDATE`. Added via the
-- pg_constraint-existence guard copied from 003_vcs_provider_foundation.sql:25-32 -- NOT
-- `DO $$ ... EXCEPTION WHEN duplicate_object`, which this codebase reserves for `CREATE TYPE`.
-- The guard's `conname` check and the `ADD CONSTRAINT` name below MUST stay byte-identical: any
-- divergence would make the guard silently no-op or raise a duplicate-constraint error on re-run.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'vcs_credentials_provider_workspace_slug_key'
  ) THEN
    ALTER TABLE vcs_credentials
      ADD CONSTRAINT vcs_credentials_provider_workspace_slug_key UNIQUE (vcs_provider, workspace, repo_slug);
  END IF;
END $$;

-- Phase 5 webhook-lookup index (review finding 13c): the webhook route resolves the repo by
-- (workspace, repo_slug) from the incoming payload BEFORE it knows/verifies the provider, so it
-- cannot use the leading-`vcs_provider` unique index above as a prefix (a B-tree prefix scan needs
-- the leftmost column). A dedicated non-unique index on (workspace, repo_slug) serves that
-- provider-less lookup. `IF NOT EXISTS` keeps it re-run safe (Pitfall 4).
CREATE INDEX IF NOT EXISTS idx_vcs_credentials_workspace_slug
  ON vcs_credentials (workspace, repo_slug);
