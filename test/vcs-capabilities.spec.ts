import { describe, expect, it } from 'vitest';
import { GithubAdapter } from '@server/vcs/github';
import { BitbucketAdapter } from '@server/vcs/bitbucket';
import { BitbucketClient } from '@server/core/bitbucket';
import { createTestEnv } from './helpers';

// SC3 (capability portion): a provider-capability flag (supportsMermaid) reports true for GitHub
// and false for Bitbucket, declared per-adapter on the VcsProvider interface (D-09). Constructing
// each adapter touches no network — `capabilities` is a plain class-field initializer.

const INSTALLATION_ID = '123456';

// Bitbucket's real entry point is the async `create` factory; its per-method contract (and its
// static capability flag) is independent of credential reading, so we exercise the private
// constructor shape via the same pass-through cast the bitbucket-adapter spec uses.
function buildBitbucketAdapter(): BitbucketAdapter {
  const env = createTestEnv();
  const client = new BitbucketClient(env, 'test-token-bearer');
  const job = {
    id: 'job-cap-1',
    owner: 'acme',
    repo: 'backend',
    prNumber: 1,
    repositoryVcsProvider: 'bitbucket',
    repositoryWorkspace: 'acme',
  };
  return new (BitbucketAdapter as unknown as new (
    env: ReturnType<typeof createTestEnv>,
    client: BitbucketClient,
    job: typeof job,
  ) => BitbucketAdapter)(env, client, job);
}

describe('VcsProvider capabilities', () => {
  it('GitHub reports supportsMermaid === true', () => {
    const adapter = new GithubAdapter(createTestEnv(), INSTALLATION_ID);
    expect(adapter.capabilities.supportsMermaid).toBe(true);
  });

  it('Bitbucket reports supportsMermaid === false', () => {
    const adapter = buildBitbucketAdapter();
    expect(adapter.capabilities.supportsMermaid).toBe(false);
  });
});
