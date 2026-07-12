import { getOrCreateRepository } from '@server/db/repositories';
import { getDb } from '@server/db/client';
import { createTestEnv, hasConfiguredTestDatabaseUrl } from './helpers';

const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;

dbDescribe('getOrCreateRepository', () => {
  const env = createTestEnv();

  it('defaults to vcs_provider="github" when vcsProvider is omitted', async () => {
    const owner = 'test-owner';
    const repo = `default-provider-${Date.now()}`;

    const id = await getOrCreateRepository(env, {
      installationId: '123',
      owner,
      repo,
    });

    expect(id).toBeGreaterThan(0);

    const [row] = await getDb(env).query<{ vcs_provider: string }>(
      'SELECT vcs_provider FROM repositories WHERE id = $1',
      [id]
    );
    expect(row?.vcs_provider).toBe('github');
  });

  it('allows a bitbucket row to coexist with a github row for the same owner/repo (FND-01)', async () => {
    const owner = 'test-owner';
    const repo = `coexist-${Date.now()}`;

    const githubId = await getOrCreateRepository(env, {
      installationId: '123',
      owner,
      repo,
      vcsProvider: 'github',
    });

    const bitbucketId = await getOrCreateRepository(env, {
      installationId: '123',
      owner,
      repo,
      vcsProvider: 'bitbucket',
    });

    expect(bitbucketId).not.toBe(githubId);

    const [githubRow] = await getDb(env).query<{ vcs_provider: string }>(
      'SELECT vcs_provider FROM repositories WHERE id = $1',
      [githubId]
    );
    const [bitbucketRow] = await getDb(env).query<{ vcs_provider: string }>(
      'SELECT vcs_provider FROM repositories WHERE id = $1',
      [bitbucketId]
    );

    expect(githubRow?.vcs_provider).toBe('github');
    expect(bitbucketRow?.vcs_provider).toBe('bitbucket');
  });
});
