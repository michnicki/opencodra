import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach } from 'vitest';
import { getDb } from '@server/db/client';
import { getOrCreateRepository, findRepositoryByBitbucketIdentity } from '@server/db/repositories';
import { createTestEnv, hasConfiguredTestDatabaseUrl } from './helpers';

// D-01 / D-03 / REV-C-1 / REV-R-C: this spec pins the post-migration-005 schema shape (nullable
// installation_id + workspace TEXT column + named UNIQUE constraint) and the lookup accessor
// behavior (`findRepositoryByBitbucketIdentity` returns the id when a row exists, null when not,
// and never returns a github row).
//
// Two assertions would naturally fit the migration-005-idempotency spec -- we keep this file
// focused on the SUCCESS-state behavior of a single apply, not the re-run safety proof.
const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;

const migrationPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../db/migrations/005_bitbucket_repo_identity.sql',
);

dbDescribe('bitbucket-identity (D-01 / D-03)', () => {
  const env = createTestEnv();
  const createdRepoIds: number[] = [];

  afterEach(async () => {
    // Self-cleanup so the shared TEST_DATABASE_URL never accumulates test rows (review finding 10).
    if (createdRepoIds.length > 0) {
      await getDb(env).query('DELETE FROM repositories WHERE id = ANY($1::int[])', [createdRepoIds]);
      createdRepoIds.length = 0;
    }
  });

  it('migration 005 leaves installation_id nullable and adds the workspace column + UNIQUE constraint', async () => {
    // Apply the raw migration against the test DB. The migration-005-idempotency spec proves
    // double-apply safety; this test only exercises the SUCCESS state of one apply (the migrate
    // harness has already applied it via npm test's setup step, so this call is idempotent on a
    // post-apply DB).
    const sql = readFileSync(migrationPath, 'utf8');
    await getDb(env).query(sql);

    // D-01: installation_id is nullable.
    const [installationCol] = await getDb(env).query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'repositories' AND column_name = 'installation_id'`,
    );
    expect(installationCol?.is_nullable).toBe('YES');

    // D-01: workspace column exists with data_type='text'.
    const [workspaceCol] = await getDb(env).query<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'repositories' AND column_name = 'workspace'`,
    );
    expect(workspaceCol?.data_type).toBe('text');

    // D-01: named UNIQUE constraint is in place.
    const [constraint] = await getDb(env).query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_constraint
         WHERE conname = 'repositories_vcs_provider_workspace_repo_key' AND contype = 'u'
       ) AS exists`,
    );
    expect(constraint.exists).toBe(true);
  });

  it('findRepositoryByBitbucketIdentity returns the row id for a matching Bitbucket repo', async () => {
    const workspace = `ws-bi-${Date.now()}`;
    const repoSlug = `repo-bi-${Date.now()}`;

    const id = await getOrCreateRepository(env, {
      installationId: '',
      owner: workspace,
      repo: repoSlug,
      vcsProvider: 'bitbucket',
      workspace,
    });
    createdRepoIds.push(id);

    const found = await findRepositoryByBitbucketIdentity(env, { workspace, repoSlug });
    expect(found).toBe(id);
  });

  it('findRepositoryByBitbucketIdentity returns null when no row exists for the identity', async () => {
    const workspace = `ws-bi-missing-${Date.now()}`;
    const repoSlug = `repo-bi-missing-${Date.now()}`;

    const found = await findRepositoryByBitbucketIdentity(env, { workspace, repoSlug });
    expect(found).toBeNull();
  });

  it('findRepositoryByBitbucketIdentity never returns a github row, even on workspace collisions', async () => {
    // Seed a github row with the same workspace + repo tuple. The bitbucket accessor must filter
    // by vcs_provider='bitbucket' and ignore this row entirely.
    const workspace = `ws-bi-collide-${Date.now()}`;
    const repoSlug = `repo-bi-collide-${Date.now()}`;

    const githubId = await getOrCreateRepository(env, {
      installationId: '99',
      owner: workspace,
      repo: repoSlug,
      vcsProvider: 'github',
    });
    createdRepoIds.push(githubId);

    const found = await findRepositoryByBitbucketIdentity(env, { workspace, repoSlug });
    expect(found).toBeNull();

    // Confirm the github row really is there -- otherwise a false-positive null could pass.
    const [githubRow] = await getDb(env).query<{ id: number; vcs_provider: string }>(
      `SELECT id, vcs_provider FROM repositories WHERE id = $1`,
      [githubId],
    );
    expect(githubRow?.vcs_provider).toBe('github');
  });
});