import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { getDb } from '@server/db/client';
import { createTestEnv, hasConfiguredTestDatabaseUrl } from './helpers';

// The migrate harness (scripts/migrate.mjs) skips already-applied files via `schema_migrations`, so
// `npm test`'s migrate step NEVER re-runs 007 -- it proves nothing about re-run safety. This dedicated
// test reads the RAW 007 SQL and executes the whole file TWICE against the shared test database,
// asserting neither run throws (T-07-03). That directly exercises the re-run-safe idioms in migration
// 007: `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE UNIQUE INDEX IF NOT EXISTS`,
// and the pg_constraint-existence guard around the mandatory `pass` CHECK.
//
// The file is executed as a single simple-query string via `getDb(env).query(sql)` (empty params ->
// postgres.js simple protocol), running all semicolon-separated statements -- including the
// dollar-quoted `DO $$ ... $$` block -- in one shot, mirroring the migrate harness's simple-query path.
const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;

const migrationPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../db/migrations/007_multipass_contract_foundation.sql',
);

dbDescribe('migration 007_multipass_contract_foundation is idempotent', () => {
  const env = createTestEnv();

  it('applies the raw 007 SQL twice without throwing (re-run safe)', async () => {
    const sql = readFileSync(migrationPath, 'utf8');

    // First apply: idempotent if the migrate step already applied it, otherwise mutates schema.
    await expect(getDb(env).query(sql)).resolves.toBeDefined();
    // Second apply: the real re-run proof -- every verb must short-circuit cleanly (IF [NOT] EXISTS
    // / the pg_constraint existence guard) on the second run.
    await expect(getDb(env).query(sql)).resolves.toBeDefined();

    // Sanity 1: file_reviews.pass exists (text, NOT NULL, DEFAULT 'main') (D-07).
    const [passCol] = await getDb(env).query<{ data_type: string; is_nullable: string; column_default: string | null }>(
      `SELECT data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'file_reviews' AND column_name = 'pass'`,
    );
    expect(passCol?.data_type).toBe('text');
    expect(passCol?.is_nullable).toBe('NO');
    expect(passCol?.column_default).toContain("'main'");

    // Sanity 2: the mandatory CHECK (pass IN ('main','security')) exists.
    const [check] = await getDb(env).query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_constraint WHERE conname = 'file_reviews_pass_check' AND contype = 'c'
       ) AS exists`,
    );
    expect(check.exists).toBe(true);

    // Sanity 3: EXPAND/CONTRACT -- BOTH the new 3-col index AND the retained old 2-col index exist.
    const [newIndex] = await getDb(env).query<{ exists: boolean }>(
      `SELECT to_regclass('public.file_reviews_job_file_path_pass_key') IS NOT NULL AS exists`,
    );
    const [oldIndex] = await getDb(env).query<{ exists: boolean }>(
      `SELECT to_regclass('public.file_reviews_job_file_path_key') IS NOT NULL AS exists`,
    );
    expect(newIndex.exists).toBe(true);
    expect(oldIndex.exists).toBe(true);

    // Sanity 4: pr_review_state.workspace is NOT NULL (Codex HIGH #2 -- one-row-per-PR for GitHub).
    const [workspaceCol] = await getDb(env).query<{ is_nullable: string }>(
      `SELECT is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'pr_review_state' AND column_name = 'workspace'`,
    );
    expect(workspaceCol?.is_nullable).toBe('NO');
  });
});
