import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { getDb } from '@server/db/client';
import { createTestEnv, hasConfiguredTestDatabaseUrl } from './helpers';

// Review finding 8: the migrate harness (scripts/migrate.mjs) skips already-applied files via the
// `schema_migrations` table, so `npm test`'s migrate step NEVER actually re-runs 004 -- it proves
// nothing about re-run safety. This dedicated test reads the RAW 004 SQL and executes the whole file
// TWICE against the shared test database, asserting neither run throws. That directly exercises the
// re-run-safe idioms in the migration: `CREATE TABLE IF NOT EXISTS`, the `pg_constraint`-existence
// guard around the UNIQUE constraint, and `CREATE INDEX IF NOT EXISTS`.
//
// The file is executed as a single simple-query string via `getDb(env).query(sql)` (empty params ->
// postgres.js simple protocol), which runs all semicolon-separated statements -- including the
// dollar-quoted `DO $$ ... $$` block -- in one shot, mirroring the unsafe/simple-query path the
// migrate harness uses.
const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;

const migrationPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../db/migrations/004_vcs_credentials.sql',
);

dbDescribe('migration 004_vcs_credentials is idempotent (finding 8)', () => {
  const env = createTestEnv();

  it('applies the raw 004 SQL twice without throwing (re-run safe)', async () => {
    const sql = readFileSync(migrationPath, 'utf8');

    // First apply: no-op if the migrate step already created the table, otherwise creates it.
    await expect(getDb(env).query(sql)).resolves.toBeDefined();
    // Second apply: must be a genuine no-op -- this is the real re-run proof.
    await expect(getDb(env).query(sql)).resolves.toBeDefined();

    // Sanity: the table, unique constraint, and lookup index all exist after re-application.
    const [table] = await getDb(env).query<{ exists: boolean }>(
      `SELECT to_regclass('public.vcs_credentials') IS NOT NULL AS exists`,
    );
    expect(table.exists).toBe(true);

    const [constraint] = await getDb(env).query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_constraint WHERE conname = 'vcs_credentials_provider_workspace_slug_key'
       ) AS exists`,
    );
    expect(constraint.exists).toBe(true);

    const [index] = await getDb(env).query<{ exists: boolean }>(
      `SELECT to_regclass('public.idx_vcs_credentials_workspace_slug') IS NOT NULL AS exists`,
    );
    expect(index.exists).toBe(true);
  });
});
