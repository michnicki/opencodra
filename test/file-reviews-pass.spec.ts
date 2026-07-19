import { describe, it, expect } from 'vitest';
import { insertJob } from '@server/db/jobs';
import { upsertFileReview, bulkMarkFilesFailed, bulkInheritFileReviews } from '@server/db/file-reviews';
import { queryRows } from '@server/db/client';
import { defaultRepoConfig } from '@shared/schema';
import { createTestEnv, hasConfiguredTestDatabaseUrl } from './helpers';

// SC1 (storage portion): prove the new file_reviews.pass column + the (job_id, file_path, pass)
// ON CONFLICT arbiter are behaviorally INERT for the existing main-pass review path. A normal insert
// (no pass supplied) lands 'main' via the column DEFAULT, and a repeat upsert for the same
// (job, path) resolves against pass='main' -> exactly one row, updated in place (identical to the
// pre-index behavior). Runs against the migrated TEST_DATABASE_URL (007 applied by `npm test`).
const sha = (char: string) => char.repeat(40);
const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;

const baseFileReview = {
  fileStatus: 'done' as const,
  modelUsed: 'test-model',
  modelProvider: 'test',
  diffLineCount: 1,
  diffInput: 'x',
  rawAiOutput: '{}',
  parsedComments: [],
  inputTokens: 1,
  outputTokens: 1,
  durationMs: 1,
  verdict: 'comment' as const,
  fileSummary: 'ok',
  errorMessage: null,
};

dbDescribe('file_reviews.pass inertness (SC1 storage portion)', () => {
  const env = createTestEnv();

  it('defaults pass to main on a normal upsert insert', async () => {
    const job = await insertJob(env, {
      installationId: '123', owner: 'test-owner', repo: `test-repo-${Date.now()}-pass-default`,
      prNumber: 1, prTitle: 'Pass default', prAuthor: 'author', commitSha: sha('a'), baseSha: sha('0'),
      trigger: 'auto', headRef: 'feature', baseRef: 'main', configSnapshot: defaultRepoConfig,
    });

    await upsertFileReview(env, job.id, { ...baseFileReview, filePath: 'src/app.ts' });

    const rows = await queryRows<{ pass: string }>(
      env, `SELECT pass FROM file_reviews WHERE job_id = $1::uuid`, [job.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].pass).toBe('main');
  });

  it('resolves a repeat upsert on the (job_id, file_path, pass) key -> exactly one main-pass row, updated in place', async () => {
    const job = await insertJob(env, {
      installationId: '123', owner: 'test-owner', repo: `test-repo-${Date.now()}-pass-upsert`,
      prNumber: 2, prTitle: 'Pass upsert', prAuthor: 'author', commitSha: sha('b'), baseSha: sha('0'),
      trigger: 'auto', headRef: 'feature', baseRef: 'main', configSnapshot: defaultRepoConfig,
    });

    // First insert as 'pending', then re-upsert the SAME file as 'done'. Pre-index behavior was a
    // single row updated in place; the new 3-col arbiter (resolving on pass='main') must be identical.
    await upsertFileReview(env, job.id, { ...baseFileReview, filePath: 'src/app.ts', fileStatus: 'pending' });
    await upsertFileReview(env, job.id, { ...baseFileReview, filePath: 'src/app.ts', fileStatus: 'done' });

    const rows = await queryRows<{ pass: string; file_status: string }>(
      env, `SELECT pass, file_status FROM file_reviews WHERE job_id = $1::uuid AND file_path = 'src/app.ts'`, [job.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].pass).toBe('main');
    expect(rows[0].file_status).toBe('done');
  });

  it('bulkMarkFilesFailed and bulkInheritFileReviews honor DO NOTHING against the new key', async () => {
    const parent = await insertJob(env, {
      installationId: '123', owner: 'test-owner', repo: `test-repo-${Date.now()}-pass-bulk-parent`,
      prNumber: 3, prTitle: 'Bulk parent', prAuthor: 'author', commitSha: sha('c'), baseSha: sha('0'),
      trigger: 'auto', headRef: 'feature', baseRef: 'main', configSnapshot: defaultRepoConfig,
    });
    const target = await insertJob(env, {
      installationId: '123', owner: 'test-owner', repo: `test-repo-${Date.now()}-pass-bulk-target`,
      prNumber: 4, prTitle: 'Bulk target', prAuthor: 'author', commitSha: sha('d'), baseSha: sha('0'),
      trigger: 'auto', headRef: 'feature', baseRef: 'main', configSnapshot: defaultRepoConfig,
    });

    // Parent has a completed review; target already has a real (done) review for the same file.
    await upsertFileReview(env, parent.id, { ...baseFileReview, filePath: 'src/a.ts' });
    await upsertFileReview(env, target.id, { ...baseFileReview, filePath: 'src/a.ts' });

    // Inherit must NOT clobber the target's existing row (ON CONFLICT (job_id, file_path, pass) DO NOTHING).
    const inherited = await bulkInheritFileReviews(env, {
      jobId: target.id, parentJobId: parent.id, filePaths: ['src/a.ts'],
    });
    expect(inherited).toEqual([]);

    // Bulk-fail over the same existing file must also DO NOTHING -- the done row survives.
    await bulkMarkFilesFailed(
      env, target.id, [{ filePath: 'src/a.ts', diffLineCount: 1 }],
      { modelUsed: 'test-model', errorMessage: 'boom' },
    );

    const rows = await queryRows<{ pass: string; file_status: string }>(
      env, `SELECT pass, file_status FROM file_reviews WHERE job_id = $1::uuid AND file_path = 'src/a.ts'`, [target.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].pass).toBe('main');
    expect(rows[0].file_status).toBe('done');
  });
});
