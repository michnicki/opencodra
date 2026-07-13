import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotImplementedError, VcsService } from '@server/services/vcs';
import { BitbucketAdapter } from '@server/vcs/bitbucket';
import { GithubAdapter } from '@server/vcs/github';
import { createTestEnv } from './helpers';

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

describe('VcsService.forProvider', () => {
  it('returns a GithubAdapter for provider: "github"', async () => {
    const env = createTestEnv();
    const adapter = await VcsService.forProvider(env, { provider: 'github', installationId: 'inst-1' });
    expect(adapter).toBeInstanceOf(GithubAdapter);
  });

  it('throws a typed NotImplementedError for provider: "bitbucket"', async () => {
    const env = createTestEnv();
    let caught: unknown = null;
    try {
      await VcsService.forProvider(env, { provider: 'bitbucket' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(NotImplementedError);
    expect((caught as Error).message).toContain('Bitbucket');
  });

  it('throws when provider is "github" without installationId', async () => {
    const env = createTestEnv();
    await expect(VcsService.forProvider(env, { provider: 'github' })).rejects.toThrow(/installationId/);
  });
});