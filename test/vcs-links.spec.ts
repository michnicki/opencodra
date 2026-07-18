import { describe, expect, it } from 'vitest';
import { commitUrl, pullRequestUrl, reviewUrl } from '@client/lib/vcs';

describe('VCS repository links', () => {
  it('defaults legacy jobs to GitHub URLs', () => {
    const repository = { owner: 'acme', repo: 'widgets' };

    expect(pullRequestUrl(repository, 42)).toBe('https://github.com/acme/widgets/pull/42');
    expect(commitUrl(repository, 'abc123')).toBe('https://github.com/acme/widgets/commit/abc123');
    expect(reviewUrl(repository, 42, 99)).toBe(
      'https://github.com/acme/widgets/pull/42#pullrequestreview-99',
    );
  });

  it('uses the Bitbucket workspace and URL shapes', () => {
    const repository = {
      owner: 'display-owner',
      repo: 'widgets',
      repositoryVcsProvider: 'bitbucket' as const,
      repositoryWorkspace: 'acme-workspace',
    };

    expect(pullRequestUrl(repository, 42)).toBe(
      'https://bitbucket.org/acme-workspace/widgets/pull-requests/42',
    );
    expect(commitUrl(repository, 'abc123')).toBe(
      'https://bitbucket.org/acme-workspace/widgets/commits/abc123',
    );
    expect(reviewUrl(repository, 42, 99)).toBeNull();
  });
});
