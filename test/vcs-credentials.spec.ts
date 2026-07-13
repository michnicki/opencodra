import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createApp } from '@server/app';
import { queryRows } from '@server/db/client';
// RED (Wave 0): neither of these modules exists yet.
//  - `@server/core/crypto` is extracted in Plan 02.
//  - `@server/db/vcs-credentials` (accessors + status helper + threshold) lands in Plan 03,
//    and the route it drives (`/api/vcs-credentials`) lands in Plan 04, backed by the
//    `vcs_credentials` table from migration 004 (Plan 03).
// This spec is EXPECTED to fail for pre-implementation reasons only (missing import or
// `relation "vcs_credentials" does not exist`). That is the acceptance criterion here.
import { decryptSecret } from '@server/core/crypto';
import {
  computeCredentialStatus,
  EXPIRING_SOON_THRESHOLD_MS,
} from '@server/db/vcs-credentials';
import { vcsCredentialStoreSchema } from '@shared/schema';
import { createTestEnv, hasConfiguredTestDatabaseUrl } from './helpers';

const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Local session helper — mirrors test/api.spec.ts::getAuthCookie (review finding 13f:
// duplicate-locally-or-extract; duplicated here for test isolation).
// ---------------------------------------------------------------------------
function mockGitHubProfile(login = 'devarshishimpi') {
  return {
    id: 42,
    login,
    name: 'Devarshi Shimpi',
    avatar_url: 'https://avatars.githubusercontent.com/u/42',
    email: null,
  };
}

async function getAuthCookie(app: ReturnType<typeof createApp>, env = createTestEnv(), login = 'devarshishimpi') {
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

  const callback = await app.request(`/auth/github/callback?code=test-code&state=${state}`, {}, env);
  const cookieHeader = callback.headers.get('set-cookie') || '';
  const match = cookieHeader.match(/codra_session=([^;]+)/);
  return match ? match[1] : '';
}

// Unique lowercase identities to survive the shared TEST_DATABASE_URL without the
// (disabled) global cleanup in test/setup.ts (review findings 10 + 11).
let identityCounter = 0;
function uniqueIdentity() {
  identityCounter += 1;
  return {
    vcsProvider: 'bitbucket',
    workspace: `ws-${Date.now()}-${identityCounter}`,
    repoSlug: `repo-${Date.now()}-${identityCounter}`,
  };
}

const createdIdentities: Array<{ workspace: string; repoSlug: string }> = [];
// Generic so the returned identity keeps its `vcsProvider` field (type-only fix; the runtime
// push shape and behavior are unchanged — only the compile-time type is preserved).
function track<T extends { workspace: string; repoSlug: string }>(id: T): T {
  createdIdentities.push({ workspace: id.workspace, repoSlug: id.repoSlug });
  return id;
}

// ---------------------------------------------------------------------------
// Pure unit coverage of the four-state status boundaries (D-05). This block does
// not touch the DB, but still RED-fails at collection because it imports
// computeCredentialStatus/EXPIRING_SOON_THRESHOLD_MS from the not-yet-created module.
// ---------------------------------------------------------------------------
describe('computeCredentialStatus four-state boundaries (D-05)', () => {
  const now = new Date('2026-07-13T00:00:00.000Z');
  const nowMs = now.getTime();

  it('returns "missing" when there is no token regardless of expiry', () => {
    expect(computeCredentialStatus({ hasToken: false, tokenExpiresAt: null }, now)).toBe('missing');
    expect(
      computeCredentialStatus(
        { hasToken: false, tokenExpiresAt: new Date(nowMs + EXPIRING_SOON_THRESHOLD_MS * 10) },
        now,
      ),
    ).toBe('missing');
  });

  it('returns "expired" when tokenExpiresAt is in the past', () => {
    expect(
      computeCredentialStatus({ hasToken: true, tokenExpiresAt: new Date(nowMs - 1000) }, now),
    ).toBe('expired');
  });

  it('returns "expiring-soon" within the threshold, inclusive of the exact boundary', () => {
    // exactly AT the threshold edge -> still expiring-soon (boundary inclusive)
    expect(
      computeCredentialStatus(
        { hasToken: true, tokenExpiresAt: new Date(nowMs + EXPIRING_SOON_THRESHOLD_MS) },
        now,
      ),
    ).toBe('expiring-soon');
    // one ms inside the window
    expect(
      computeCredentialStatus(
        { hasToken: true, tokenExpiresAt: new Date(nowMs + EXPIRING_SOON_THRESHOLD_MS - 1) },
        now,
      ),
    ).toBe('expiring-soon');
  });

  it('returns "valid" beyond the threshold, and for a token with no expiry', () => {
    expect(
      computeCredentialStatus(
        { hasToken: true, tokenExpiresAt: new Date(nowMs + EXPIRING_SOON_THRESHOLD_MS + 1) },
        now,
      ),
    ).toBe('valid');
    expect(computeCredentialStatus({ hasToken: true, tokenExpiresAt: null }, now)).toBe('valid');
  });

  it('fails closed to "expired" on an unparseable expiry string (WR-01)', () => {
    expect(computeCredentialStatus({ hasToken: true, tokenExpiresAt: 'not-a-date' }, now)).toBe(
      'expired',
    );
  });

  it('uses a ~14 day expiring-soon threshold (D-05)', () => {
    expect(EXPIRING_SOON_THRESHOLD_MS).toBe(14 * 24 * 60 * 60 * 1000);
  });
});

describe('vcsCredentialStoreSchema.tokenExpiresAt strict-ISO validation (IN-02)', () => {
  const parseExpiry = (tokenExpiresAt: unknown) =>
    vcsCredentialStoreSchema.safeParse({
      workspace: 'ws',
      repoSlug: 'repo',
      tokenExpiresAt,
    });

  it('accepts a bare date-only YYYY-MM-DD (the dashboard type="date" contract)', () => {
    expect(parseExpiry('2026-07-13').success).toBe(true);
  });

  it('accepts a full RFC3339 datetime', () => {
    expect(parseExpiry('2026-07-13T00:00:00.000Z').success).toBe(true);
    expect(parseExpiry('2026-07-13T00:00:00+02:00').success).toBe(true);
  });

  it('accepts null and undefined (optional/nullable)', () => {
    expect(parseExpiry(null).success).toBe(true);
    expect(vcsCredentialStoreSchema.safeParse({ workspace: 'ws', repoSlug: 'repo' }).success).toBe(
      true,
    );
  });

  it('rejects non-ISO / locale formats that the old Date.parse refine let through', () => {
    expect(parseExpiry('not-a-date').success).toBe(false);
    expect(parseExpiry('2026/07/13').success).toBe(false);
    expect(parseExpiry('March 5 2099').success).toBe(false);
    expect(parseExpiry('3/5/2099').success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DB + route integration. Drives createApp() with a real session cookie against
// the shared test Postgres.
// ---------------------------------------------------------------------------
dbDescribe('/api/vcs-credentials route + storage integration', () => {
  const app = createApp();
  const env = createTestEnv();

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    // Self-cleanup: the global table cleanup in test/setup.ts is disabled (finding 10).
    for (const { workspace, repoSlug } of createdIdentities) {
      try {
        await queryRows(
          env,
          'DELETE FROM vcs_credentials WHERE workspace = $1 AND repo_slug = $2',
          [workspace, repoSlug],
        );
      } catch {
        // table may not exist yet in RED — ignore.
      }
    }
    createdIdentities.length = 0;
  });

  async function authedPost(cookie: string, body: unknown, withCsrf = true) {
    return app.request(
      '/api/vcs-credentials',
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

  async function authedGet(cookie: string) {
    return app.request(
      '/api/vcs-credentials',
      { headers: { Cookie: `codra_session=${cookie}` } },
      env,
    );
  }

  async function authedDelete(cookie: string, id: { vcsProvider: string; workspace: string; repoSlug: string }) {
    return app.request(
      `/api/vcs-credentials/${id.vcsProvider}/${id.workspace}/${id.repoSlug}`,
      {
        method: 'DELETE',
        headers: {
          Cookie: `codra_session=${cookie}`,
          'x-requested-with': 'XMLHttpRequest',
        },
      },
      env,
    );
  }

  // 1. AUTH-02 / crit.1 (store side, T-04-01): ciphertext at rest + decrypt round-trip.
  it('persists secrets as ciphertext at rest and decrypts back to the originals (AUTH-02 / T-04-01)', async () => {
    const cookie = await getAuthCookie(app, env);
    const id = track(uniqueIdentity());
    const accessToken = 'ATBB-plaintext-access-token';
    const webhookSecret = 'plaintext-webhook-secret';

    const res = await authedPost(cookie, { ...id, accessToken, webhookSecret });
    expect(res.status).toBe(200);

    const [row] = await queryRows<{ encrypted_access_token: string; encrypted_webhook_secret: string }>(
      env,
      'SELECT encrypted_access_token, encrypted_webhook_secret FROM vcs_credentials WHERE vcs_provider = $1 AND workspace = $2 AND repo_slug = $3',
      [id.vcsProvider, id.workspace, id.repoSlug],
    );
    expect(row.encrypted_access_token).not.toBe(accessToken);
    expect(row.encrypted_webhook_secret).not.toBe(webhookSecret);
    expect(await decryptSecret(env, row.encrypted_access_token)).toBe(accessToken);
    expect(await decryptSecret(env, row.encrypted_webhook_secret)).toBe(webhookSecret);
  });

  // 2. AUTH-03 / crit.3 / D-10 (read side, T-04-01): redacted response, never ciphertext/plaintext.
  it('returns only redacted status fields, never token/secret plaintext or ciphertext (AUTH-03 / D-10)', async () => {
    const cookie = await getAuthCookie(app, env);
    const id = track(uniqueIdentity());
    const accessToken = 'ATBB-secret-should-never-serialize';
    const webhookSecret = 'webhook-should-never-serialize';

    const postRes = await authedPost(cookie, { ...id, accessToken, webhookSecret, label: 'prod' });
    const postBody = await postRes.json() as any;
    expect(postRes.status).toBe(200);
    expect(postBody.credential).toMatchObject({
      hasToken: true,
      hasWebhookSecret: true,
      label: 'prod',
    });
    expect(typeof postBody.credential.status).toBe('string');

    const getRes = await authedGet(cookie);
    const getBody = await getRes.json() as any;
    expect(getRes.status).toBe(200);
    expect(Array.isArray(getBody.credentials)).toBe(true);
    const entry = getBody.credentials.find(
      (c: any) => c.workspace === id.workspace && c.repoSlug === id.repoSlug,
    );
    expect(entry).toBeTruthy();
    expect(entry).toMatchObject({ hasToken: true, hasWebhookSecret: true });

    for (const raw of [JSON.stringify(postBody), JSON.stringify(getBody)]) {
      expect(raw).not.toContain(accessToken);
      expect(raw).not.toContain(webhookSecret);
      expect(raw).not.toContain('encrypted_');
    }
  });

  // 4. crit.4 / D-11 + findings 1/3: rotate in place, omit-untouched, omit-expiry/label-preserved, clear->null, no dup.
  it('rotates in place, preserves omitted fields, clears on request, and never duplicates the row (D-11 / findings 1,3)', async () => {
    const cookie = await getAuthCookie(app, env);
    const id = track(uniqueIdentity());
    const firstToken = 'ATBB-first-token';
    const secondToken = 'ATBB-rotated-token';
    const firstExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    // Initial create with both secrets + expiry + label.
    expect((await authedPost(cookie, {
      ...id,
      accessToken: firstToken,
      webhookSecret: 'wh-1',
      tokenExpiresAt: firstExpiry,
      label: 'original',
    })).status).toBe(200);

    // Rotate the token only -> ciphertext changes, decrypts to the new value.
    expect((await authedPost(cookie, { ...id, accessToken: secondToken })).status).toBe(200);

    let rows = await queryRows<{ encrypted_access_token: string; label: string | null; token_expires_at: string | null }>(
      env,
      'SELECT encrypted_access_token, label, token_expires_at FROM vcs_credentials WHERE vcs_provider = $1 AND workspace = $2 AND repo_slug = $3',
      [id.vcsProvider, id.workspace, id.repoSlug],
    );
    expect(rows).toHaveLength(1); // upsert, no duplicate row
    expect(await decryptSecret(env, rows[0].encrypted_access_token)).toBe(secondToken);

    // Update label + expiry while omitting accessToken -> stored token ciphertext UNCHANGED.
    const cipherAfterRotate = rows[0].encrypted_access_token;
    const newExpiry = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
    expect((await authedPost(cookie, { ...id, label: 'updated', tokenExpiresAt: newExpiry })).status).toBe(200);

    rows = await queryRows<{ encrypted_access_token: string; label: string | null; token_expires_at: string | null }>(
      env,
      'SELECT encrypted_access_token, label, token_expires_at FROM vcs_credentials WHERE vcs_provider = $1 AND workspace = $2 AND repo_slug = $3',
      [id.vcsProvider, id.workspace, id.repoSlug],
    );
    expect(rows[0].encrypted_access_token).toBe(cipherAfterRotate); // token untouched
    expect(rows[0].label).toBe('updated');

    // Review finding 1: rotate ONLY webhookSecret, OMITTING tokenExpiresAt + label ->
    // previously-stored expiry + label must be PRESERVED (not nulled by EXCLUDED-overwrite).
    expect((await authedPost(cookie, { ...id, webhookSecret: 'wh-2' })).status).toBe(200);
    // Type param includes encrypted_access_token to stay assignable to the `rows` variable's
    // declared type (line ~276); the column is not selected here and is never read (type-only).
    rows = await queryRows<{ encrypted_access_token: string; label: string | null; token_expires_at: string | null }>(
      env,
      'SELECT label, token_expires_at FROM vcs_credentials WHERE vcs_provider = $1 AND workspace = $2 AND repo_slug = $3',
      [id.vcsProvider, id.workspace, id.repoSlug],
    );
    expect(rows[0].label).toBe('updated');
    expect(rows[0].token_expires_at).not.toBeNull();

    // Review finding 3: clearToken:true -> hasToken false on the subsequent GET.
    expect((await authedPost(cookie, { ...id, clearToken: true })).status).toBe(200);
    const getBody = await (await authedGet(cookie)).json() as any;
    const entry = getBody.credentials.find(
      (c: any) => c.workspace === id.workspace && c.repoSlug === id.repoSlug,
    );
    expect(entry.hasToken).toBe(false);
  });

  // 5. AUTH-01 / D-13: delete -> missing, and no api.bitbucket.org call anywhere in the flow.
  it('deletes the credential (reads missing after) and never calls api.bitbucket.org (AUTH-01 / D-13)', async () => {
    const cookie = await getAuthCookie(app, env);

    // Record every fetch URL after auth; routes in this phase must not hit Bitbucket.
    const fetchUrls: string[] = [];
    const originalFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      fetchUrls.push(String(input));
      return originalFetch(input, init);
    });

    const id = track(uniqueIdentity());
    expect((await authedPost(cookie, { ...id, accessToken: 'ATBB-x', webhookSecret: 'wh-x' })).status).toBe(200);

    const delRes = await authedDelete(cookie, id);
    expect(delRes.status).toBe(200);
    expect(await delRes.json()).toEqual({ ok: true });

    const getBody = await (await authedGet(cookie)).json() as any;
    const entry = getBody.credentials.find(
      (c: any) => c.workspace === id.workspace && c.repoSlug === id.repoSlug,
    );
    expect(entry).toBeUndefined(); // absent from the list => missing

    expect(fetchUrls.some((u) => u.includes('api.bitbucket.org'))).toBe(false);
  });

  // 6. D-12 / T-04-04: auth + CSRF rejection.
  it('rejects unauthenticated requests (401) and missing-CSRF mutations (403) (D-12 / T-04-04)', async () => {
    // No session cookie at all -> 401 on GET and POST.
    const unauthGet = await app.request('/api/vcs-credentials', {}, env);
    expect(unauthGet.status).toBe(401);

    const unauthPost = await app.request(
      '/api/vcs-credentials',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest' },
        body: JSON.stringify(uniqueIdentity()),
      },
      env,
    );
    expect(unauthPost.status).toBe(401);

    // Session cookie present but missing x-requested-with -> 403.
    const cookie = await getAuthCookie(app, env);
    const id = track(uniqueIdentity());
    const noCsrf = await authedPost(cookie, { ...id, accessToken: 'ATBB-y', webhookSecret: 'wh-y' }, false);
    expect(noCsrf.status).toBe(403);
  });

  // 7. Review finding 2: create requires BOTH secrets; rotation may omit either.
  it('requires both secrets to CREATE a new credential, but allows a rotation to omit either (finding 2)', async () => {
    const cookie = await getAuthCookie(app, env);
    const id = track(uniqueIdentity());

    // Brand-new identity with ONLY an access token -> 400.
    const onlyToken = await authedPost(cookie, { ...id, accessToken: 'ATBB-only' });
    expect(onlyToken.status).toBe(400);

    // Same new identity with BOTH secrets -> 200 (created).
    const both = await authedPost(cookie, { ...id, accessToken: 'ATBB-both', webhookSecret: 'wh-both' });
    expect(both.status).toBe(200);

    // Now that it exists, a rotation omitting the webhook secret -> 200.
    const rotate = await authedPost(cookie, { ...id, accessToken: 'ATBB-rotated' });
    expect(rotate.status).toBe(200);
  });

  // 8. Review finding 5: malformed tokenExpiresAt rejected at the Zod write boundary.
  it('rejects a malformed tokenExpiresAt with 400 before it reaches the TIMESTAMPTZ insert (finding 5)', async () => {
    const cookie = await getAuthCookie(app, env);
    const id = track(uniqueIdentity());
    const res = await authedPost(cookie, {
      ...id,
      accessToken: 'ATBB-z',
      webhookSecret: 'wh-z',
      tokenExpiresAt: 'not-a-date',
    });
    expect(res.status).toBe(400);
  });
});
