import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { getDb } from '@server/db/client';
import { createTestEnv, hasConfiguredTestDatabaseUrl } from './helpers';

// Review finding 8: the migrate harness (scripts/migrate.mjs) skips already-applied files via the
// `schema_migrations` table, so `npm test`'s migrate step NEVER actually re-runs 005 -- it proves
// nothing about re-run safety. This dedicated test reads the RAW 005 SQL and executes the whole file
// TWICE against the shared test database, asserting neither run throws. That directly exercises
// the re-run-safe idioms in migration 005: `ADD COLUMN IF NOT EXISTS workspace`, the
// `pg_constraint`-existence guard around the new UNIQUE constraint, the `information_schema`
// guard around `ALTER COLUMN ... DROP NOT NULL`, and `CREATE INDEX IF NOT EXISTS`.
//
// The file is executed as a single simple-query string via `getDb(env).query(sql)` (empty params ->
// postgres.js simple protocol), which runs all semicolon-separated statements -- including the
// dollar-quoted `DO $$ ... $$` block -- in one shot, mirroring the unsafe/simple-query path the
// migrate harness uses.
const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;

const migrationPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../db/migrations/005_bitbucket_repo_identity.sql',
);

dbDescribe('migration 005_bitbucket_repo_identity is idempotent (finding 8)', () => {
  const env = createTestEnv();

  it('applies the raw 005 SQL twice without throwing (re-run safe)', async () => {
    const sql = readFileSync(migrationPath, 'utf8');

    // First apply: idempotent if the migrate step already applied it, otherwise mutates schema.
    await expect(getDb(env).query(sql)).resolves.toBeDefined();
    // Second apply: must be a genuine no-op -- this is the real re-run proof. The
    // `is_nullable='NO'` guard inside the DO $$ ... END $$ block must short-circuit cleanly
    // on the second run because the column is already 'YES' from the first apply.
    await expect(getDb(env).query(sql)).resolves.toBeDefined();

    // Sanity 1: repositories.installation_id became nullable (D-01).
    const [installationCol] = await getDb(env).query<{ is_nullable: string }>(
      `SELECT is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'repositories'
         AND column_name = 'installation_id'`,
    );
    expect(installationCol?.is_nullable).toBe('YES');

    // Sanity 2: repositories.workspace exists with data_type='text' (D-01).
    const [workspaceCol] = await getDb(env).query<{ data_type: string }>(
      `SELECT data_type
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'repositories'
         AND column_name = 'workspace'`,
    );
    expect(workspaceCol?.data_type).toBe('text');

    // Sanity 3: pg_constraint has the named UNIQUE constraint (D-01 / REV-C-1).
    const [constraint] = await getDb(env).query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_constraint
         WHERE conname = 'repositories_vcs_provider_workspace_repo_key'
           AND contype = 'u'
       ) AS exists`,
    );
    expect(constraint.exists).toBe(true);

    // Sanity 4: the workspace prefix-lookup index exists (D-01).
    const [index] = await getDb(env).query<{ exists: boolean }>(
      `SELECT to_regclass('public.idx_repositories_workspace_repo') IS NOT NULL AS exists`,
    );
    expect(index.exists).toBe(true);
  });
});