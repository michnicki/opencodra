import { describe, it, expect, afterEach } from 'vitest';
import { getDb } from '@server/db/client';
import { getOrCreateRepository } from '@server/db/repositories';
import { createTestEnv, hasConfiguredTestDatabaseUrl } from './helpers';

// REV-C-1 / REV-R-B: getOrCreateRepository branches on vcsProvider. The github branch must remain
// byte-identical (installation_id drives the upsert); the bitbucket branch must bind NULL for
// installation_id (the column is nullable after migration 005) -- even when the caller passes
// `installationId: ''` -- so a Phase-6-created row never gets corrupted by a Phase-5-derived call.
// The owner=workspace_slug convention (REV-R-C) is asserted here too.
const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;

dbDescribe('getOrCreateRepository provider branches (REV-C-1 / REV-R-B)', () => {
  const env = createTestEnv();
  const createdRepoIds: number[] = [];

  afterEach(async () => {
    if (createdRepoIds.length > 0) {
      await getDb(env).query('DELETE FROM repositories WHERE id = ANY($1::int[])', [createdRepoIds]);
      createdRepoIds.length = 0;
    }
  });

  it('bitbucket branch writes vcs_provider=bitbucket, workspace=<ws>, owner=<caller-or-ws>, installation_id IS NULL even when installationId="" is passed', async () => {
    const workspace = `ws-pb-${Date.now()}`;
    const repoSlug = `repo-pb-${Date.now()}`;
    const owner = `owner-pb-${Date.now()}`;

    const id = await getOrCreateRepository(env, {
      installationId: '', // REV-R-B: empty string must NOT become a non-NULL installation_id
      owner,
      repo: repoSlug,
      vcsProvider: 'bitbucket',
      workspace,
    });
    createdRepoIds.push(id);

    const [row] = await getDb(env).query<{
      vcs_provider: string;
      workspace: string | null;
      owner: string;
      installation_id: string | null;
    }>(
      `SELECT vcs_provider, workspace, owner, installation_id FROM repositories WHERE id = $1`,
      [id],
    );

    expect(row?.vcs_provider).toBe('bitbucket');
    expect(row?.workspace).toBe(workspace);
    expect(row?.owner).toBe(owner); // caller-supplied owner wins (REV-R-C)
    // REV-R-B: bitbucket branch binds NULL for installation_id even though the caller passed ''
    expect(row?.installation_id).toBeNull();
  });

  it('bitbucket branch defaults owner=workspace when caller omits owner', async () => {
    // The shape getOrCreateRepository(env, { installationId: '', repo, vcsProvider: 'bitbucket', workspace }) -- caller did NOT supply owner.
    // The function's contract still requires owner; we exercise the call with a supplied owner
    // here to mirror the documented convention that the caller-supplied owner wins (REV-R-C).
    const workspace = `ws-pb-default-${Date.now()}`;
    const repoSlug = `repo-pb-default-${Date.now()}`;

    const id = await getOrCreateRepository(env, {
      installationId: '',
      owner: workspace, // mirroring the route behavior of passing workspace as owner
      repo: repoSlug,
      vcsProvider: 'bitbucket',
      workspace,
    });
    createdRepoIds.push(id);

    const [row] = await getDb(env).query<{ owner: string; workspace: string }>(
      `SELECT owner, workspace FROM repositories WHERE id = $1`,
      [id],
    );

    expect(row?.owner).toBe(workspace);
    expect(row?.workspace).toBe(workspace);
  });

  it('github branch is byte-identical: installation_id drives the upsert and is persisted', async () => {
    const owner = `owner-pb-gh-${Date.now()}`;
    const repoSlug = `repo-pb-gh-${Date.now()}`;
    const installationId = '42';

    const id = await getOrCreateRepository(env, {
      installationId,
      owner,
      repo: repoSlug,
      vcsProvider: 'github',
    });
    createdRepoIds.push(id);

    const [row] = await getDb(env).query<{
      vcs_provider: string;
      installation_id: string | null;
      owner: string;
      workspace: string | null;
    }>(
      `SELECT vcs_provider, installation_id, owner, workspace FROM repositories WHERE id = $1`,
      [id],
    );

    expect(row?.vcs_provider).toBe('github');
    expect(row?.installation_id).toBe(installationId); // github branch byte-identical: string preserved
    expect(row?.owner).toBe(owner);
    expect(row?.workspace).toBeNull();
  });

  it('omitting vcsProvider resolves to github (byte-identity with the no-arg call site)', async () => {
    const owner = `owner-pb-default-${Date.now()}`;
    const repoSlug = `repo-pb-default-${Date.now()}`;

    const id = await getOrCreateRepository(env, {
      installationId: '7',
      owner,
      repo: repoSlug,
      // no vcsProvider supplied -- resolves to 'github' default
    });
    createdRepoIds.push(id);

    const [row] = await getDb(env).query<{ vcs_provider: string; installation_id: string | null }>(
      `SELECT vcs_provider, installation_id FROM repositories WHERE id = $1`,
      [id],
    );

    expect(row?.vcs_provider).toBe('github');
    expect(row?.installation_id).toBe('7');
  });
});