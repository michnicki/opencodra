import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// RED (Wave 0): hoisted vi.mock (06-REVIEWS.md MEDIUM finding, Codex) -- ESM named imports are
// read-only live bindings, so wrapping `upsertVcsCredential` to force a one-time failure MUST
// happen via `vi.mock`, not a post-import monkey-patch. `importOriginal` resolves the REAL
// `@server/db/vcs-credentials` module, which already exists (Phase 4/Wave 3 of this phase) -- only
// this spec's route + schema imports below are the RED-contract targets.
vi.mock('@server/db/vcs-credentials', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@server/db/vcs-credentials')>();
  return {
    ...actual,
    upsertVcsCredential: vi.fn(actual.upsertVcsCredential),
  };
});

import { createApp } from '@server/app';
import { queryRows } from '@server/db/client';
import { upsertVcsCredential } from '@server/db/vcs-credentials';
// RED (Wave 0): `addBitbucketRepoInputSchema` does not exist yet on `@shared/bitbucket` -- it
// lands in Wave 3 (06-04-PLAN.md) per the contract-first convention (Zod schema authored before
// the route handler that consumes it). This import is expected to fail to resolve at collection
// time; that missing-module-export signal IS the acceptance criterion for this plan. Do NOT
// create the schema or the `POST /bitbucket` route here.
import { addBitbucketRepoInputSchema } from '@shared/bitbucket';
import { createTestEnv, hasConfiguredTestDatabaseUrl } from './helpers';

const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;

function mockGitHubProfile(login = 'devarshishimpi') {
  return {
    id: 42,
    login,
    name: 'Devarshi Shimpi',
    avatar_url: 'https://avatars.githubusercontent.com/u/42',
    email: null,
  };
}

// Local session helper -- mirrors test/vcs-credentials.spec.ts::getAuthCookie, duplicated here for
// test isolation (that file's own precedent: it duplicates test/api.spec.ts's helper for the same
// reason, review finding 13f). requireSession only gates on ANY authenticated session -- GitHub
// login is sufficient to drive the CSRF/auth gates on the new Bitbucket add-repo endpoint.
async function getAuthCookie(app: ReturnType<typeof createApp>, env: ReturnType<typeof createTestEnv>, login = 'devarshishimpi') {
  const originalFetch = globalThis.fetch;

  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === 'https://github.com/login/oauth/access_token') {
      return Response.json({ access_token: 'oauth-access-token' });
    }
    if (url === 'https://api.github.com/user') {
      return Response.json(mockGitHubProfile(login));
    }
    return originalFetch(input, init);
  });

  const authStart = await app.request('/auth/github', {}, env);
  const authLocation = authStart.headers.get('location');
  const state = authLocation ? new URL(authLocation).searchParams.get('state') : null;

  const stateCookie = (authStart.headers.get('set-cookie') || '').match(/codra_oauth_state=[^;]+/)?.[0] ?? '';
  const callback = await app.request(`/auth/github/callback?code=test-code&state=${state}`, { headers: { cookie: stateCookie } }, env);
  const cookieHeader = callback.headers.get('set-cookie') || '';
  const match = cookieHeader.match(/codra_session=([^;]+)/);
  return match ? match[1] : '';
}

async function authedPost(
  app: ReturnType<typeof createApp>,
  env: ReturnType<typeof createTestEnv>,
  cookie: string,
  body: unknown,
  withCsrf = true,
) {
  return app.request(
    '/api/repos/bitbucket',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Cookie: `codra_session=${cookie}`,
        ...(withCsrf ? { 'x-requested-with': 'XMLHttpRequest' } : {}),
      },
      body: JSON.stringify(body),
    },
    env,
  );
}

dbDescribe('POST /api/repos/bitbucket — D-32 transactional add-repo endpoint', () => {
  const env = createTestEnv();
  const app = createApp();

  const IDENTITY = { workspace: 'my-ws', repoSlug: 'my-repo' };
  const ROLLBACK_IDENTITY = { workspace: 'my-ws-rollback', repoSlug: 'my-repo-rollback' };
  const validBody = {
    workspace: IDENTITY.workspace,
    repoSlug: IDENTITY.repoSlug,
    // Deviation (Rule 1 auto-fix, 06-04 execution): the original sentinel value 'tok' collides
    // with the *legitimate, unredacted* response field name `tokenExpiresAt` (which always
    // contains the lowercase substring "tok"), so the Case-7 "never leaks" assertion below would
    // fail for ANY correct implementation, not just a leaky one. 'zzk' carries the same intent
    // (a short, distinctive sentinel unlikely to appear anywhere else in the response) without
    // colliding with any real field/value.
    accessToken: 'zzk',
    webhookSecret: 'sec',
    tokenExpiresAt: '2027-01-01',
  };

  async function deleteIdentity(identity: { workspace: string; repoSlug: string }) {
    await queryRows(
      env,
      `DELETE FROM vcs_credentials WHERE vcs_provider = 'bitbucket' AND workspace = $1 AND repo_slug = $2`,
      [identity.workspace, identity.repoSlug],
    );
    await queryRows(
      env,
      `DELETE FROM repositories WHERE vcs_provider = 'bitbucket' AND workspace = $1 AND repo = $2`,
      [identity.workspace, identity.repoSlug],
    );
  }

  beforeAll(async () => {
    await deleteIdentity(IDENTITY);
    await deleteIdentity(ROLLBACK_IDENTITY);
  });

  afterAll(async () => {
    await deleteIdentity(IDENTITY);
    await deleteIdentity(ROLLBACK_IDENTITY);
  });

  it('rejects a request without a session cookie (401)', async () => {
    const res = await app.request(
      '/api/repos/bitbucket',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest' },
        body: JSON.stringify(validBody),
      },
      env,
    );
    expect(res.status).toBe(401);
  });

  it('rejects a valid session without the x-requested-with CSRF header (403)', async () => {
    const cookie = await getAuthCookie(app, env);
    const res = await authedPost(app, env, cookie, validBody, false);
    expect(res.status).toBe(403);
  });

  it('rejects a body that fails Zod strict parse -- missing workspace (400)', async () => {
    const { workspace, ...invalidBody } = validBody;
    // RED-contract check: addBitbucketRepoInputSchema does not exist yet on @shared/bitbucket,
    // so this throws (rather than silently passing) until Wave 3 authors the schema.
    expect(addBitbucketRepoInputSchema.safeParse(invalidBody).success).toBe(false);

    const cookie = await getAuthCookie(app, env);
    const res = await authedPost(app, env, cookie, invalidBody);
    expect(res.status).toBe(400);
    const json = (await res.json()) as unknown;
    expect(JSON.stringify(json)).toContain('Invalid Bitbucket repository payload.');
  });

  describe('happy path (single transactional insert, D-32)', () => {
    let responseStatus: number;
    let responseJson: any;

    beforeAll(async () => {
      // RED-contract check: same reasoning as above -- proves the schema doesn't exist yet
      // rather than relying solely on the route's incidental 404.
      expect(addBitbucketRepoInputSchema.safeParse(validBody).success).toBe(true);

      const cookie = await getAuthCookie(app, env);
      const res = await authedPost(app, env, cookie, validBody);
      responseStatus = res.status;
      responseJson = await res.json();
    });

    it('returns 201 with the full redacted VcsCredentialStatus shape', () => {
      expect(responseStatus).toBe(201);
      expect(responseJson).toMatchObject({
        credential: {
          hasToken: true,
          hasWebhookSecret: true,
          vcsProvider: 'bitbucket',
          workspace: IDENTITY.workspace,
          repoSlug: IDENTITY.repoSlug,
          status: expect.stringMatching(/^(valid|expiring-soon)$/),
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
        },
      });
    });

    it('persists a repositories row with vcs_provider=bitbucket and installation_id NULL', async () => {
      const rows = await queryRows<{
        vcs_provider: string;
        owner: string;
        repo: string;
        workspace: string | null;
        installation_id: string | null;
      }>(
        env,
        `SELECT vcs_provider, owner, repo, workspace, installation_id FROM repositories WHERE workspace = $1 AND repo = $2`,
        [IDENTITY.workspace, IDENTITY.repoSlug],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        vcs_provider: 'bitbucket',
        owner: IDENTITY.workspace,
        repo: IDENTITY.repoSlug,
        workspace: IDENTITY.workspace,
        installation_id: null,
      });
    });

    it('persists an encrypted vcs_credentials row (v2: ciphertext, not plaintext)', async () => {
      const rows = await queryRows<{
        vcs_provider: string;
        encrypted_access_token: string | null;
        encrypted_webhook_secret: string | null;
      }>(
        env,
        `SELECT vcs_provider, encrypted_access_token, encrypted_webhook_secret FROM vcs_credentials WHERE vcs_provider = 'bitbucket' AND workspace = $1 AND repo_slug = $2`,
        [IDENTITY.workspace, IDENTITY.repoSlug],
      );
      expect(rows).toHaveLength(1);
      const [row] = rows;
      // New writes use the PBKDF2 v2 envelope (`v2:salt:iv:ciphertext`); v1 rows remain
      // decrypt-only for backward compatibility but are never produced on insert.
      expect(row.encrypted_access_token).toMatch(/^v2:/);
      expect(row.encrypted_webhook_secret).toMatch(/^v2:/);
      expect(row.encrypted_access_token).not.toBe('zzk');
      expect(row.encrypted_webhook_secret).not.toBe('sec');
    });

    it('never leaks plaintext or ciphertext in the response body (Phase 4 D-10 redaction)', () => {
      const serialized = JSON.stringify(responseJson);
      expect(serialized).not.toContain('zzk');
      expect(serialized).not.toContain('sec');
      expect(serialized).not.toContain('v2:');
    });
  });

  it('rolls back the whole transaction when upsertVcsCredential fails after getOrCreateRepository succeeds (success criterion 3)', async () => {
    const cookie = await getAuthCookie(app, env);

    vi.mocked(upsertVcsCredential).mockImplementationOnce(() => {
      throw new Error('forced failure');
    });

    const res = await authedPost(app, env, cookie, {
      workspace: ROLLBACK_IDENTITY.workspace,
      repoSlug: ROLLBACK_IDENTITY.repoSlug,
      accessToken: 'rollback-tok',
      webhookSecret: 'rollback-sec',
    });

    expect(res.status).toBe(500);

    const rows = await queryRows<{ count: string }>(
      env,
      `SELECT count(*)::text AS count FROM repositories WHERE workspace = $1 AND repo = $2`,
      [ROLLBACK_IDENTITY.workspace, ROLLBACK_IDENTITY.repoSlug],
    );
    expect(rows[0].count).toBe('0');
  });

  it('idempotently re-adds the same repo, rotating the encrypted access token on each call (D-11)', async () => {
    const cookie = await getAuthCookie(app, env);

    const firstRes = await authedPost(app, env, cookie, { ...validBody, accessToken: 'tok-rotated-1' });
    expect(firstRes.status).toBe(201);
    const [firstRow] = await queryRows<{ encrypted_access_token: string }>(
      env,
      `SELECT encrypted_access_token FROM vcs_credentials WHERE vcs_provider = 'bitbucket' AND workspace = $1 AND repo_slug = $2`,
      [IDENTITY.workspace, IDENTITY.repoSlug],
    );

    const secondRes = await authedPost(app, env, cookie, { ...validBody, accessToken: 'tok-rotated-2' });
    expect(secondRes.status).toBe(201);
    const [secondRow] = await queryRows<{ encrypted_access_token: string }>(
      env,
      `SELECT encrypted_access_token FROM vcs_credentials WHERE vcs_provider = 'bitbucket' AND workspace = $1 AND repo_slug = $2`,
      [IDENTITY.workspace, IDENTITY.repoSlug],
    );

    expect(secondRow.encrypted_access_token).not.toBe(firstRow.encrypted_access_token);
  });

  it('does not introduce a sibling getOrCreateBitbucketRepository helper (D-32 LOCKED)', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/server/db/repositories.ts'), 'utf8');
    expect(source.includes('getOrCreateBitbucketRepository')).toBe(false);
  });
});
