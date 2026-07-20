import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { getDb } from '@server/db/client';
import { createTestEnv, hasConfiguredTestDatabaseUrl } from './helpers';

// The migrate harness (scripts/migrate.mjs) skips already-applied files via `schema_migrations`, so
// `npm test`'s migrate step NEVER re-runs 009 -- it proves nothing about re-run safety. This dedicated
// test reads the RAW 009 SQL and executes the whole file TWICE against the shared test database,
// asserting neither run throws. That directly exercises the re-run-safe idioms in migration 009:
// `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, and `ADD COLUMN IF NOT EXISTS`.
//
// The file is executed as a single simple-query string via `getDb(env).query(sql)` (empty params ->
// postgres.js simple protocol), running all semicolon-separated statements in one shot, mirroring the
// migrate harness's simple-query path.
const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;

const migrationPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../db/migrations/009_bot_commands_qa.sql',
);

dbDescribe('migration 009_bot_commands_qa is idempotent', () => {
  const env = createTestEnv();

  it('applies the raw 009 SQL twice without throwing (re-run safe)', async () => {
    const sql = readFileSync(migrationPath, 'utf8');

    // First apply: idempotent if the migrate step already applied it, otherwise mutates schema.
    await expect(getDb(env).query(sql)).resolves.toBeDefined();
    // Second apply: the real re-run proof -- every verb must short-circuit cleanly (IF [NOT] EXISTS).
    await expect(getDb(env).query(sql)).resolves.toBeDefined();

    // Sanity 1: skipped_files exists with its UNIQUE(job_id, file_path) and BYTEA head_sha.
    const [skippedTable] = await getDb(env).query<{ exists: boolean }>(
      `SELECT to_regclass('public.skipped_files') IS NOT NULL AS exists`,
    );
    expect(skippedTable.exists).toBe(true);

    const [headShaCol] = await getDb(env).query<{ data_type: string; is_nullable: string }>(
      `SELECT data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'skipped_files' AND column_name = 'head_sha'`,
    );
    expect(headShaCol?.data_type).toBe('bytea');
    expect(headShaCol?.is_nullable).toBe('NO');

    const [skippedUnique] = await getDb(env).query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.skipped_files'::regclass AND contype = 'u'
       ) AS exists`,
    );
    expect(skippedUnique.exists).toBe(true);

    // Sanity 2: reject_feedback exists with UNIQUE(vcs_provider, source_comment_ref).
    const [rejectTable] = await getDb(env).query<{ exists: boolean }>(
      `SELECT to_regclass('public.reject_feedback') IS NOT NULL AS exists`,
    );
    expect(rejectTable.exists).toBe(true);

    const [rejectUnique] = await getDb(env).query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.reject_feedback'::regclass AND contype = 'u'
       ) AS exists`,
    );
    expect(rejectUnique.exists).toBe(true);

    // Sanity 3: the two additive jobs columns exist and are NULLABLE (behaviorally inert, NREG-01).
    const cols = await getDb(env).query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'jobs'
         AND column_name IN ('review_scope', 'scope_source_job_id')
       ORDER BY column_name`,
    );
    expect(cols.map((c) => c.column_name)).toEqual(['review_scope', 'scope_source_job_id']);
    expect(cols.every((c) => c.is_nullable === 'YES')).toBe(true);
  });
});
