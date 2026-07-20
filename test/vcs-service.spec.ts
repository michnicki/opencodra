import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotImplementedError, VcsService } from '@server/services/vcs';
import { BitbucketAdapter } from '@server/vcs/bitbucket';
import { GithubAdapter } from '@server/vcs/github';
import { createTestEnv } from './helpers';
import { installBitbucketFetchMock } from './bitbucket-fetch-mock';

// Mock the credential-read + decrypt path so we don't depend on Postgres or the encryption key.
const getVcsCredentialSecretsMock = vi.fn();
const decryptSecretMock = vi.fn();
vi.mock('@server/db/vcs-credentials', () => ({
  getVcsCredentialSecrets: (...args: unknown[]) => getVcsCredentialSecretsMock(...args),
}));
vi.mock('@server/core/crypto', () => ({
  decryptSecret: (...args: unknown[]) => decryptSecretMock(...args),
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('VcsService.forRepo', () => {
  it('returns a GithubAdapter when repositoryVcsProvider is unset (default branch)', async () => {
    const env = createTestEnv();
    const adapter = await VcsService.forRepo(
      env,
      { installationId: '123', repositoryVcsProvider: null },
    );
    expect(adapter).toBeInstanceOf(GithubAdapter);
    expect((adapter as GithubAdapter).name).toBe('github');
  });

  it('returns a GithubAdapter when repositoryVcsProvider is "github"', async () => {
    const env = createTestEnv();
    const adapter = await VcsService.forRepo(
      env,
      { installationId: '123', repositoryVcsProvider: 'github' },
    );
    expect(adapter).toBeInstanceOf(GithubAdapter);
  });

  it('returns a BitbucketAdapter when repositoryVcsProvider is "bitbucket" AND credential is present', async () => {
    const env = createTestEnv();
    getVcsCredentialSecretsMock.mockResolvedValue({
      vcsProvider: 'bitbucket',
      workspace: 'ws-foo',
      repoSlug: 'repo-bar',
      hasToken: true,
      hasWebhookSecret: false,
      tokenExpiresAt: null,
      label: null,
      status: 'valid',
      createdAt: new Date(),
      updatedAt: new Date(),
      encryptedAccessToken: 'v1:iv:ct',
      encryptedWebhookSecret: null,
    });
    decryptSecretMock.mockResolvedValue('plaintext-token');

    const adapter = await VcsService.forRepo(
      env,
      {
        installationId: null,
        repositoryVcsProvider: 'bitbucket',
        repositoryWorkspace: 'ws-foo',
      },
    );
    expect(adapter).toBeInstanceOf(BitbucketAdapter);
    expect((adapter as BitbucketAdapter).name).toBe('bitbucket');

    // The credential read was performed with the canonical key.
    // Use expect.anything() for env (its APP_PRIVATE_KEY getter throws on access; see
    // review-resilience.spec.ts for the same pattern).
    expect(getVcsCredentialSecretsMock).toHaveBeenCalledTimes(1);
    expect(getVcsCredentialSecretsMock).toHaveBeenCalledWith(expect.anything(), {
      vcsProvider: 'bitbucket',
      workspace: 'ws-foo',
      repoSlug: undefined,
    });

    // The decrypt call was made on the returned ciphertext.
    expect(decryptSecretMock).toHaveBeenCalledTimes(1);
    expect(decryptSecretMock).toHaveBeenCalledWith(expect.anything(), 'v1:iv:ct');
  });

  it('throws when repositoryVcsProvider is "bitbucket" but no credential row exists', async () => {
    const env = createTestEnv();
    getVcsCredentialSecretsMock.mockResolvedValue(null);

    await expect(
      VcsService.forRepo(
        env,
        {
          installationId: null,
          repositoryVcsProvider: 'bitbucket',
          repositoryWorkspace: 'ws-foo',
        },
      ),
    ).rejects.toThrow(/Bitbucket credential not configured for ws-foo/);

    // Decryption was NOT attempted when there's no row.
    expect(decryptSecretMock).not.toHaveBeenCalled();
  });

  it('throws when repositoryVcsProvider is "bitbucket" but encryptedAccessToken is null', async () => {
    const env = createTestEnv();
    getVcsCredentialSecretsMock.mockResolvedValue({
      vcsProvider: 'bitbucket',
      workspace: 'ws-foo',
      repoSlug: 'repo-bar',
      hasToken: false,
      hasWebhookSecret: false,
      tokenExpiresAt: null,
      label: null,
      status: 'missing',
      createdAt: new Date(),
      updatedAt: new Date(),
      encryptedAccessToken: null,
      encryptedWebhookSecret: null,
    });

    await expect(
      VcsService.forRepo(
        env,
        {
          installationId: null,
          repositoryVcsProvider: 'bitbucket',
          repositoryWorkspace: 'ws-foo',
        },
      ),
    ).rejects.toThrow(/Bitbucket credential not configured/);
  });
});

describe('VcsService.forRepo — Bitbucket headSha population (empty-commit 404 regression)', () => {
  // Regression for the BitbucketError 404 on `PUT .../commit//reports/codra-review`: the adapter's
  // updateStatusCheck reads `this.job.headSha ?? ''`, but neither caller supplied headSha. The
  // mapped PersistedReviewJob exposes it as `commitSha` (hex); the maintenance sweep passes it as an
  // explicit `headSha` (hex-decoded from the commit_sha bytea). forRepo normalizes both so the Code
  // Insights PUT + build-status POST always target a non-empty commit segment.
  function mockValidBitbucketCredential() {
    getVcsCredentialSecretsMock.mockResolvedValue({ encryptedAccessToken: 'v1:iv:ct' });
    decryptSecretMock.mockResolvedValue('plaintext-token');
  }

  it('derives headSha from the mapped job commitSha so updateStatusCheck targets the real commit (not /commit//)', async () => {
    const env = createTestEnv();
    mockValidBitbucketCredential();
    const mock = installBitbucketFetchMock();

    const adapter = await VcsService.forRepo(env, {
      id: 'job-live',
      owner: 'ws-foo',
      repo: 'repo-bar',
      prNumber: 7,
      installationId: null,
      repositoryVcsProvider: 'bitbucket',
      repositoryWorkspace: 'ws-foo',
      // The mapped PersistedReviewJob carries commitSha (hex), NOT headSha.
      commitSha: 'deadbeefcafe0001',
    } as Parameters<typeof VcsService.forRepo>[1]);

    await adapter.updateStatusCheck('ws-foo', 'repo-bar', 'codra-review', {
      title: 'Comments posted',
      summary: '2 inline comments across 1 file.',
      status: 'completed',
      conclusion: 'neutral',
    });

    // The Code Insights PUT must carry the real commit hash (non-empty segment). Note: the fetch
    // mock's route regex requires `/commit/[^/]+/` — an empty segment would fall through to a 404,
    // exactly reproducing the pre-fix BitbucketError.
    const put = mock.calls.find((c) => c.method === 'PUT' && c.path.includes('/reports/codra-review'));
    expect(put?.path).toBe('/2.0/repositories/ws-foo/repo-bar/commit/deadbeefcafe0001/reports/codra-review');

    // The build-status POST likewise targets the real commit.
    const post = mock.calls.find((c) => c.method === 'POST' && c.path.includes('/statuses/build'));
    expect(post?.path).toBe('/2.0/repositories/ws-foo/repo-bar/commit/deadbeefcafe0001/statuses/build');

    // Regression guard: NO request went to an empty /commit// segment (the pre-fix 404 route).
    expect(mock.calls.some((c) => c.path.includes('/commit//'))).toBe(false);
  });

  it('prefers an explicit headSha over commitSha (the maintenance sweep passes the hex-decoded commit_sha)', async () => {
    const env = createTestEnv();
    mockValidBitbucketCredential();
    const mock = installBitbucketFetchMock();

    const adapter = await VcsService.forRepo(env, {
      id: 'job-maint',
      owner: 'ws-foo',
      repo: 'repo-bar',
      prNumber: 7,
      installationId: null,
      repositoryVcsProvider: 'bitbucket',
      repositoryWorkspace: 'ws-foo',
      headSha: 'explicitsha99',
      commitSha: 'shouldnotwin',
    } as Parameters<typeof VcsService.forRepo>[1]);

    await adapter.updateStatusCheck('ws-foo', 'repo-bar', 'codra-review', {
      title: 'LGTM',
      summary: 'ok',
      status: 'completed',
      conclusion: 'success',
    });

    const put = mock.calls.find((c) => c.method === 'PUT' && c.path.includes('/reports/codra-review'));
    expect(put?.path).toContain('/commit/explicitsha99/reports/');
    expect(put?.path).not.toContain('shouldnotwin');
  });
});

describe('VcsService.forProvider', () => {
  it('returns a GithubAdapter for provider: "github"', async () => {
    const env = createTestEnv();
    const adapter = await VcsService.forProvider(env, { provider: 'github', installationId: 'inst-1' });
    expect(adapter).toBeInstanceOf(GithubAdapter);
  });

  it('builds a JOBLESS BitbucketAdapter for provider: "bitbucket" given { workspace, repo } (no longer throws)', async () => {
    const env = createTestEnv();
    getVcsCredentialSecretsMock.mockResolvedValue({ encryptedAccessToken: 'v1:iv:ct' });
    decryptSecretMock.mockResolvedValue('plaintext-token');

    const adapter = await VcsService.forProvider(env, {
      provider: 'bitbucket',
      workspace: 'ws-foo',
      repo: 'repo-bar',
    });

    expect(adapter).toBeInstanceOf(BitbucketAdapter);
    expect((adapter as BitbucketAdapter).name).toBe('bitbucket');
    // The jobless provider reuses the EXISTING per-repo credential decrypt path (no new token source).
    expect(getVcsCredentialSecretsMock).toHaveBeenCalledTimes(1);
    expect(decryptSecretMock).toHaveBeenCalledTimes(1);
  });

  it('throws for provider: "bitbucket" without workspace/repo (a jobless provider needs both)', async () => {
    const env = createTestEnv();
    await expect(VcsService.forProvider(env, { provider: 'bitbucket' })).rejects.toThrow(/workspace and repo/);
    // NotImplementedError remains exported for future not-yet-wired branches.
    expect(NotImplementedError).toBeDefined();
  });

  it('throws when provider is "github" without installationId', async () => {
    const env = createTestEnv();
    await expect(VcsService.forProvider(env, { provider: 'github' })).rejects.toThrow(/installationId/);
  });
});