import { describe, it, expect } from 'vitest';
import {
  insertJob,
  getJobForProcessing,
  mapJob,
  updateJobWalkthroughCommentRef,
  updateJobCriticResult,
} from '@server/db/jobs';
import { defaultRepoConfig, type CriticResult } from '@shared/schema';
import { createTestEnv, hasConfiguredTestDatabaseUrl } from './helpers';

// SC1 (jobs portion): prove the migration-007 jobs.walkthrough_comment_ref / jobs.critic_result
// columns are behaviorally INERT for the existing insert path. insertJob's explicit column list omits
// them, so a normal insert reads them back as null (the columns flow in via the SELECT i.* read).
// After the single-writer updaters run, a re-read surfaces the written values (round-trip). Runs
// against the migrated TEST_DATABASE_URL (007 applied by `npm test`).
const sha = (char: string) => char.repeat(40);
const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;

const baseJob = {
  installationId: '123',
  owner: 'test-owner',
  prTitle: 'Jobs columns inertness',
  prAuthor: 'author',
  trigger: 'auto' as const,
  headRef: 'feature',
  baseRef: 'main',
  configSnapshot: defaultRepoConfig,
};

dbDescribe('jobs.walkthrough_comment_ref / critic_result inertness (SC1 jobs portion)', () => {
  const env = createTestEnv();

  it('are null on a normal insert (insertJob omits the columns -> behaviorally inert)', async () => {
    const job = await insertJob(env, {
      ...baseJob,
      repo: `test-repo-${Date.now()}-cols-insert`,
      prNumber: 1,
      commitSha: sha('a'),
      baseSha: sha('0'),
    });

    expect(job.walkthroughCommentRef).toBeNull();
    expect(job.criticResult).toBeNull();
  });

  it('round-trip through updateJobWalkthroughCommentRef', async () => {
    const job = await insertJob(env, {
      ...baseJob,
      repo: `test-repo-${Date.now()}-cols-walkthrough`,
      prNumber: 2,
      commitSha: sha('b'),
      baseSha: sha('0'),
    });

    await updateJobWalkthroughCommentRef(env, job.id, 'walkthrough-comment-42');

    const row = await getJobForProcessing(env, job.id);
    expect(row).not.toBeNull();
    expect(mapJob(row!).walkthroughCommentRef).toBe('walkthrough-comment-42');
  });

  it('round-trip through updateJobCriticResult (JSONB parse on read)', async () => {
    const job = await insertJob(env, {
      ...baseJob,
      repo: `test-repo-${Date.now()}-cols-critic`,
      prNumber: 3,
      commitSha: sha('c'),
      baseSha: sha('0'),
    });

    const critic: CriticResult = {
      kept: [],
      pruned: [],
      model: 'test-critic-model',
      inputTokens: 10,
      outputTokens: 5,
    };
    await updateJobCriticResult(env, job.id, critic);

    const row = await getJobForProcessing(env, job.id);
    expect(row).not.toBeNull();
    const mapped = mapJob(row!);
    expect(mapped.criticResult).toEqual(critic);
  });

  it('updateJobWalkthroughCommentRef can clear the ref back to null', async () => {
    const job = await insertJob(env, {
      ...baseJob,
      repo: `test-repo-${Date.now()}-cols-clear`,
      prNumber: 4,
      commitSha: sha('d'),
      baseSha: sha('0'),
    });

    await updateJobWalkthroughCommentRef(env, job.id, 'ref-then-cleared');
    await updateJobWalkthroughCommentRef(env, job.id, null);

    const row = await getJobForProcessing(env, job.id);
    expect(row).not.toBeNull();
    expect(mapJob(row!).walkthroughCommentRef).toBeNull();
  });
});
