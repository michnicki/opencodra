import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { queryRows } from '@server/db/client';
import {
  getRepoConfigRecord,
  listRepoConfigs,
  upsertRepoConfig,
  updateRepoConfigEnabled,
} from '@server/db/repo-configs';
import { getOrCreateRepository } from '@server/db/repositories';
import { defaultRepoConfig, normalizeRepoConfig } from '@shared/schema';
import { createTestEnv, hasConfiguredTestDatabaseUrl } from './helpers';

// Requires migrations 001-009 applied to TEST_DATABASE_URL (run via `npm test`). Skipped when no
// test database is configured, matching test/add-bitbucket-repo.spec.ts.
const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;

// Unique per-run namespace so the never-reset test DB does not accumulate colliding rows across
// runs (Codra test-env quirk). Bitbucket identities are stored lowercase, so keep names lowercase.
const RUN = `p1204${Date.now().toString(36)}`;

dbDescribe('repo-configs — Bitbucket read/write path (D-04/D-05, provider isolation)', () => {
  const env = createTestEnv();

  // Every owner/workspace this spec seeds. afterAll purges repo_configs (by repository_id) then the
  // repositories rows, for both providers, so nothing leaks into other specs' list reads.
  const owners = new Set<string>();

  async function purge(owner: string) {
    await queryRows(
      env,
      `DELETE FROM repo_configs WHERE repository_id IN (SELECT id FROM repositories WHERE owner = $1)`,
      [owner],
    );
    await queryRows(env, `DELETE FROM repositories WHERE owner = $1`, [owner]);
  }

  async function purgeAll() {
    for (const owner of owners) {
      await purge(owner);
    }
  }

  // Seed a Bitbucket repositories row (NULL installation_id) via the real bitbucket branch.
  async function seedBitbucketRepo(workspace: string, repo: string) {
    owners.add(workspace);
    return getOrCreateRepository(env, {
      installationId: '',
      vcsProvider: 'bitbucket',
      owner: workspace,
      repo,
      workspace,
    });
  }

  // Seed a GitHub repositories row (non-null installation_id) via the real github branch.
  async function seedGithubRepo(owner: string, repo: string, installationId: string) {
    owners.add(owner);
    return getOrCreateRepository(env, { installationId, owner, repo });
  }

  beforeAll(async () => {
    await purgeAll();
  });

  afterAll(async () => {
    await purgeAll();
  });

  it('D-04: a Bitbucket row with NULL installation_id + a repo_config maps without throwing (installationId null, workspace populated)', async () => {
    const ws = `${RUN}d04`;
    const repo = 'repo-a';
    await seedBitbucketRepo(ws, repo);
    // Materialize a config via the provider-aware write path.
    await upsertRepoConfig(env, {
      vcsProvider: 'bitbucket',
      workspace: ws,
      installationId: null,
      owner: ws,
      repo,
      parsedJson: defaultRepoConfig,
    });

    const record = await getRepoConfigRecord(env, ws, repo, 'bitbucket');
    expect(record).not.toBeNull();
    expect(record?.installationId).toBeNull();
    expect(record?.workspace).toBe(ws);
    expect(record?.vcsProvider).toBe('bitbucket');

    // Also proves listRepoConfigs maps the NULL-installation row without a Zod 500.
    const list = await listRepoConfigs(env);
    const listed = list.find((r) => r.owner === ws && r.repo === repo);
    expect(listed).toBeDefined();
    expect(listed?.installationId).toBeNull();
  });

  it('D-05 list materialization: a config-less Bitbucket repo is returned by listRepoConfigs; a config-less GitHub repo is NOT', async () => {
    const ws = `${RUN}mat`;
    const bbRepo = 'bb-nocfg';
    const ghRepo = 'gh-nocfg';
    await seedBitbucketRepo(ws, bbRepo); // no repo_config created
    await seedGithubRepo(ws, ghRepo, '5001'); // no repo_config created

    const list = await listRepoConfigs(env);
    const bb = list.find((r) => r.owner === ws && r.repo === bbRepo);
    const gh = list.find((r) => r.owner === ws && r.repo === ghRepo);

    expect(bb).toBeDefined(); // materialized default surfaced it
    expect(bb?.vcsProvider).toBe('bitbucket');
    expect(gh).toBeUndefined(); // GitHub is never materialized
  });

  it('D-05 read lazy default: getRepoConfigRecord for a config-less Bitbucket repo returns a persisted default that round-trips', async () => {
    const ws = `${RUN}lazy`;
    const repo = 'lazy-repo';
    await seedBitbucketRepo(ws, repo); // no repo_config

    const record = await getRepoConfigRecord(env, ws, repo, 'bitbucket');
    expect(record).not.toBeNull();
    expect(record?.installationId).toBeNull();
    expect(record?.parsedJson).toEqual(normalizeRepoConfig(defaultRepoConfig));

    // The default was persisted: a repo_config row now exists for this repository.
    const [{ count }] = await queryRows<{ count: string }>(
      env,
      `SELECT count(*)::text AS count FROM repo_configs rc
         JOIN repositories r ON rc.repository_id = r.id
        WHERE r.vcs_provider = 'bitbucket' AND r.workspace = $1 AND r.repo = $2`,
      [ws, repo],
    );
    expect(count).toBe('1');

    // A subsequent provider-aware upsert round-trips through the same repository row.
    await upsertRepoConfig(env, {
      vcsProvider: 'bitbucket',
      workspace: ws,
      installationId: null,
      owner: ws,
      repo,
      parsedJson: { ...defaultRepoConfig, review: { ...defaultRepoConfig.review, max_files: 42 } },
    });
    const after = await getRepoConfigRecord(env, ws, repo, 'bitbucket');
    expect(after?.parsedJson.review.max_files).toBe(42);
  });

  it('D-05 write: upsertRepoConfig with vcsProvider=bitbucket keeps installation_id NULL and does not create a same-named GitHub row', async () => {
    const ws = `${RUN}write`;
    const repo = 'write-repo';
    await seedBitbucketRepo(ws, repo);

    await upsertRepoConfig(env, {
      vcsProvider: 'bitbucket',
      workspace: ws,
      installationId: null,
      owner: ws,
      repo,
      parsedJson: defaultRepoConfig,
    });

    const rows = await queryRows<{ vcs_provider: string; installation_id: string | null }>(
      env,
      `SELECT vcs_provider, installation_id FROM repositories WHERE owner = $1 AND repo = $2`,
      [ws, repo],
    );
    expect(rows).toHaveLength(1); // ONLY the Bitbucket row — no GitHub row cross-created
    expect(rows[0].vcs_provider).toBe('bitbucket');
    expect(rows[0].installation_id).toBeNull();
  });

  it('provider isolation: same-named GitHub+Bitbucket reads resolve per-provider and updateRepoConfigEnabled toggles exactly one row', async () => {
    const name = `${RUN}iso`;
    owners.add(name);

    // Same owner/repo TEXT for both providers (allowed by migration 003). upsertRepoConfig creates
    // both the repositories row and its config through the provider-correct branch.
    await upsertRepoConfig(env, {
      installationId: '9001',
      owner: name,
      repo: name,
      parsedJson: defaultRepoConfig,
      enabled: true,
    });
    await upsertRepoConfig(env, {
      vcsProvider: 'bitbucket',
      workspace: name,
      installationId: null,
      owner: name,
      repo: name,
      parsedJson: defaultRepoConfig,
      enabled: true,
    });

    const gh = await getRepoConfigRecord(env, name, name, 'github');
    const bb = await getRepoConfigRecord(env, name, name, 'bitbucket');
    expect(gh?.vcsProvider).toBe('github');
    expect(gh?.installationId).toBe('9001');
    expect(bb?.vcsProvider).toBe('bitbucket');
    expect(bb?.installationId).toBeNull();

    // Toggle ONLY the Bitbucket row off.
    await updateRepoConfigEnabled(env, {
      owner: name,
      repo: name,
      enabled: false,
      vcsProvider: 'bitbucket',
    });

    const ghAfter = await getRepoConfigRecord(env, name, name, 'github');
    const bbAfter = await getRepoConfigRecord(env, name, name, 'bitbucket');
    expect(bbAfter?.enabled).toBe(false); // toggled
    expect(ghAfter?.enabled).toBe(true); // untouched
  });
});
