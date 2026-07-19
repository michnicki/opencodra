import { describe, it, expect } from 'vitest';
import { insertJob } from '@server/db/jobs';
import { upsertFileReview, bulkMarkFilesFailed, bulkInheritFileReviews, getFileReviewsForJobs } from '@server/db/file-reviews';
import { queryRows } from '@server/db/client';
import { defaultRepoConfig, type ParsedReviewComment } from '@shared/schema';
import { createTestEnv, hasConfiguredTestDatabaseUrl } from './helpers';

// SC1 (storage portion): prove the file_reviews.pass column + the (job_id, file_path, pass)
// ON CONFLICT arbiter are behaviorally INERT for the existing main-pass path AND that main/security
// UNITS coexist and never conflate on inherit / bulk-fail. Runs against the migrated
// TEST_DATABASE_URL (007+008 applied by `npm test`).
const sha = (char: string) => char.repeat(40);
const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;

const baseFileReview = {
  fileStatus: 'done' as const,
  modelUsed: 'test-model',
  modelProvider: 'test',
  diffLineCount: 1,
  diffInput: 'x',
  rawAiOutput: '{}',
  parsedComments: [] as ParsedReviewComment[],
  inputTokens: 1,
  outputTokens: 1,
  durationMs: 1,
  verdict: 'comment' as const,
  fileSummary: 'ok',
  errorMessage: null,
};

const mainComment: ParsedReviewComment = {
  path: 'src/x.ts', line: 1, severity: 'P2', category: 'bugs', title: 'main finding', body: 'from main pass',
};
const secComment: ParsedReviewComment = {
  path: 'src/x.ts', line: 2, severity: 'P1', category: 'security', title: 'sec finding', body: 'from security pass',
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

  it('lets a (file, main) and a (file, security) row coexist after upsert', async () => {
    const job = await insertJob(env, {
      installationId: '123', owner: 'test-owner', repo: `test-repo-${Date.now()}-pass-coexist`,
      prNumber: 3, prTitle: 'Coexist', prAuthor: 'author', commitSha: sha('c'), baseSha: sha('0'),
      trigger: 'auto', headRef: 'feature', baseRef: 'main', configSnapshot: defaultRepoConfig,
    });

    await upsertFileReview(env, job.id, { ...baseFileReview, filePath: 'src/x.ts', pass: 'main' });
    await upsertFileReview(env, job.id, { ...baseFileReview, filePath: 'src/x.ts', pass: 'security' });

    const rows = await queryRows<{ pass: string }>(
      env, `SELECT pass FROM file_reviews WHERE job_id = $1::uuid AND file_path = 'src/x.ts' ORDER BY pass`, [job.id],
    );
    expect(rows.map((r) => r.pass)).toEqual(['main', 'security']);
  });
});

dbDescribe('file_reviews UNIT-keyed inheritance / bulk-fail (no cross-pass conflation)', () => {
  const env = createTestEnv();

  it('inherits both passes with each pass keeping ONLY its own comments (no cross-pass leakage)', async () => {
    const parent = await insertJob(env, {
      installationId: '123', owner: 'test-owner', repo: `test-repo-${Date.now()}-inherit-parent`,
      prNumber: 10, prTitle: 'Inherit parent', prAuthor: 'author', commitSha: sha('d'), baseSha: sha('0'),
      trigger: 'auto', headRef: 'feature', baseRef: 'main', configSnapshot: defaultRepoConfig,
    });
    const target = await insertJob(env, {
      installationId: '123', owner: 'test-owner', repo: `test-repo-${Date.now()}-inherit-target`,
      prNumber: 11, prTitle: 'Inherit target', prAuthor: 'author', commitSha: sha('e'), baseSha: sha('0'),
      trigger: 'auto', headRef: 'feature', baseRef: 'main', configSnapshot: defaultRepoConfig,
    });

    // Parent has DISTINCT main + security comments for the SAME path.
    await upsertFileReview(env, parent.id, { ...baseFileReview, filePath: 'src/x.ts', pass: 'main', parsedComments: [mainComment] });
    await upsertFileReview(env, parent.id, { ...baseFileReview, filePath: 'src/x.ts', pass: 'security', parsedComments: [secComment] });

    const inherited = await bulkInheritFileReviews(env, {
      jobId: target.id, parentJobId: parent.id,
      units: [{ filePath: 'src/x.ts', pass: 'main' }, { filePath: 'src/x.ts', pass: 'security' }],
    });
    expect(inherited).toEqual(
      expect.arrayContaining([
        { filePath: 'src/x.ts', pass: 'main' },
        { filePath: 'src/x.ts', pass: 'security' },
      ]),
    );
    expect(inherited).toHaveLength(2);

    const reviews = await getFileReviewsForJobs(env, [target.id]);
    const mainRow = reviews.find((r) => r.pass === 'main');
    const secRow = reviews.find((r) => r.pass === 'security');
    expect(mainRow?.parsed_comments.map((c) => c.title)).toEqual(['main finding']);
    expect(secRow?.parsed_comments.map((c) => c.title)).toEqual(['sec finding']);
  });

  it('a security-disabled retry (only the main unit requested) inherits NO security row', async () => {
    const parent = await insertJob(env, {
      installationId: '123', owner: 'test-owner', repo: `test-repo-${Date.now()}-secoff-parent`,
      prNumber: 12, prTitle: 'Sec-off parent', prAuthor: 'author', commitSha: sha('f'), baseSha: sha('0'),
      trigger: 'auto', headRef: 'feature', baseRef: 'main', configSnapshot: defaultRepoConfig,
    });
    const target = await insertJob(env, {
      installationId: '123', owner: 'test-owner', repo: `test-repo-${Date.now()}-secoff-target`,
      prNumber: 13, prTitle: 'Sec-off target', prAuthor: 'author', commitSha: sha('a'), baseSha: sha('1'),
      trigger: 'auto', headRef: 'feature', baseRef: 'main', configSnapshot: defaultRepoConfig,
    });

    await upsertFileReview(env, parent.id, { ...baseFileReview, filePath: 'src/x.ts', pass: 'main', parsedComments: [mainComment] });
    await upsertFileReview(env, parent.id, { ...baseFileReview, filePath: 'src/x.ts', pass: 'security', parsedComments: [secComment] });

    const inherited = await bulkInheritFileReviews(env, {
      jobId: target.id, parentJobId: parent.id, units: [{ filePath: 'src/x.ts', pass: 'main' }],
    });
    expect(inherited).toEqual([{ filePath: 'src/x.ts', pass: 'main' }]);

    const rows = await queryRows<{ pass: string }>(
      env, `SELECT pass FROM file_reviews WHERE job_id = $1::uuid AND file_path = 'src/x.ts'`, [target.id],
    );
    expect(rows.map((r) => r.pass)).toEqual(['main']);
  });

  it('bulkInheritFileReviews still honors DO NOTHING against an existing target row', async () => {
    const parent = await insertJob(env, {
      installationId: '123', owner: 'test-owner', repo: `test-repo-${Date.now()}-donothing-parent`,
      prNumber: 14, prTitle: 'DoNothing parent', prAuthor: 'author', commitSha: sha('b'), baseSha: sha('2'),
      trigger: 'auto', headRef: 'feature', baseRef: 'main', configSnapshot: defaultRepoConfig,
    });
    const target = await insertJob(env, {
      installationId: '123', owner: 'test-owner', repo: `test-repo-${Date.now()}-donothing-target`,
      prNumber: 15, prTitle: 'DoNothing target', prAuthor: 'author', commitSha: sha('c'), baseSha: sha('3'),
      trigger: 'auto', headRef: 'feature', baseRef: 'main', configSnapshot: defaultRepoConfig,
    });

    await upsertFileReview(env, parent.id, { ...baseFileReview, filePath: 'src/a.ts' });
    await upsertFileReview(env, target.id, { ...baseFileReview, filePath: 'src/a.ts' });

    const inherited = await bulkInheritFileReviews(env, {
      jobId: target.id, parentJobId: parent.id, units: [{ filePath: 'src/a.ts', pass: 'main' }],
    });
    expect(inherited).toEqual([]);
  });

  it('bulkMarkFilesFailed marks a missing security unit failed without touching the existing main row', async () => {
    const job = await insertJob(env, {
      installationId: '123', owner: 'test-owner', repo: `test-repo-${Date.now()}-markfail`,
      prNumber: 16, prTitle: 'Mark fail', prAuthor: 'author', commitSha: sha('d'), baseSha: sha('4'),
      trigger: 'auto', headRef: 'feature', baseRef: 'main', configSnapshot: defaultRepoConfig,
    });

    // Existing done main row for the file.
    await upsertFileReview(env, job.id, { ...baseFileReview, filePath: 'src/y.ts', pass: 'main' });

    await bulkMarkFilesFailed(
      env, job.id, [{ filePath: 'src/y.ts', pass: 'security', diffLineCount: 1 }],
      { modelUsed: 'test-model', errorMessage: 'security unit missing' },
    );

    const rows = await queryRows<{ pass: string; file_status: string }>(
      env, `SELECT pass, file_status FROM file_reviews WHERE job_id = $1::uuid AND file_path = 'src/y.ts' ORDER BY pass`, [job.id],
    );
    expect(rows).toEqual([
      { pass: 'main', file_status: 'done' },
      { pass: 'security', file_status: 'failed' },
    ]);
  });
});
