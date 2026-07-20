import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { getDb, queryRows } from '@server/db/client';
import { insertJob } from '@server/db/jobs';
import { defaultRepoConfig } from '@shared/schema';
import { createTestEnv, hasConfiguredTestDatabaseUrl } from './helpers';

// The migrate harness (scripts/migrate.mjs) skips already-applied files via `schema_migrations`, so
// `npm test`'s migrate step NEVER re-runs 008 -- it proves nothing about re-run safety. This dedicated
// test reads the RAW 008 SQL and executes the whole file TWICE against the shared test database,
// asserting neither run throws (T-10-02). By the time this runs the migrate step has already applied
// 008 once (dropping the legacy 2-col index), so BOTH runs here are the real re-run proof: a
// `DROP INDEX IF EXISTS` on an already-absent index is a clean no-op.
//
// The file is executed as a single simple-query string via `getDb(env).query(sql)` (empty params ->
// postgres.js simple protocol), mirroring the migrate harness's simple-query path.
const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;

const sha = (char: string) => char.repeat(40);

const migrationPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../db/migrations/008_drop_legacy_file_reviews_unique_index.sql',
);

dbDescribe('migration 008_drop_legacy_file_reviews_unique_index is idempotent', () => {
  const env = createTestEnv();

  it('applies the raw 008 SQL twice without throwing and leaves only the 3-col arbiter', async () => {
    const sql = readFileSync(migrationPath, 'utf8');

    // Both applies exercise the re-run-safe idiom: `DROP INDEX IF EXISTS` short-circuits cleanly when
    // the legacy index is already gone (which it is, dropped by the migrate step before vitest ran).
    await expect(getDb(env).query(sql)).resolves.toBeDefined();
    await expect(getDb(env).query(sql)).resolves.toBeDefined();

    // The retained 3-col arbiter (created in 007) must survive -- 008 must never drop it.
    const [newIndex] = await getDb(env).query<{ exists: boolean }>(
      `SELECT to_regclass('public.file_reviews_job_file_path_pass_key') IS NOT NULL AS exists`,
    );
    expect(newIndex.exists).toBe(true);

    // The legacy 2-col index must be gone.
    const [oldIndex] = await getDb(env).query<{ exists: boolean }>(
      `SELECT to_regclass('public.file_reviews_job_file_path_key') IS NOT NULL AS exists`,
    );
    expect(oldIndex.exists).toBe(false);
  });

  it('lets a (file, main) and a (file, security) row coexist for the same file after the drop', async () => {
    const job = await insertJob(env, {
      installationId: '123', owner: 'test-owner', repo: `test-repo-${Date.now()}-008-coexist`,
      prNumber: 1, prTitle: 'Coexist', prAuthor: 'author', commitSha: sha('a'), baseSha: sha('0'),
      trigger: 'auto', headRef: 'feature', baseRef: 'main', configSnapshot: defaultRepoConfig,
    });

    // Two rows for the same (job_id, file_path) differing ONLY by pass. Under the legacy 2-col unique
    // index the second insert would raise a unique violation; under the 3-col arbiter it succeeds.
    await queryRows(
      env,
      `INSERT INTO file_reviews (job_id, file_path, pass, file_status, model_used, diff_line_count)
       VALUES ($1::uuid, 'src/app.ts', 'main', 'done', 'test-model', 1),
              ($1::uuid, 'src/app.ts', 'security', 'done', 'test-model', 1)`,
      [job.id],
    );

    const rows = await queryRows<{ pass: string }>(
      env,
      `SELECT pass FROM file_reviews WHERE job_id = $1::uuid AND file_path = 'src/app.ts' ORDER BY pass`,
      [job.id],
    );
    expect(rows.map((r) => r.pass)).toEqual(['main', 'security']);
  });
});
