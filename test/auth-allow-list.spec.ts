import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '@server/env';
import { createOAuthState } from '@server/core/oauth';
import { MemoryKV } from './helpers';

// RED (Wave 0): `@server/routes/auth-bitbucket` does not exist yet — it lands in Wave 2
// (06-03-PLAN.md) per D-33. This import is expected to fail to resolve at collection time; that
// missing-module signal IS the acceptance criterion for this plan. Do NOT create the router here.
//
// Cross-wave dependency note: this spec also depends on Wave 1's `dashboardSessionUserSchema` /
// `createSession` accepting the Bitbucket variant (D-26) -- until Wave 1 lands, `createSession`'s
// parameter type is still the GitHub-only shape, so this spec is expected to be doubly RED
// (missing module AND, once Wave 1 lands but before Wave 2, a type mismatch on the createSession
// call). This resolves once Wave 2 lands (mirrors the note in test/bitbucket-oauth.spec.ts).
import { createAuthBitbucketRouter } from '@server/routes/auth-bitbucket';

// Hoisted vi.mock (not a post-import monkey-patch -- ESM named imports are read-only live
// bindings) so we can assert createSession was invoked with the discriminated-union Bitbucket
// variant (D-26) while still exercising the real KV-backed session write. Mirrors the
// vi.hoisted + vi.mock pattern already used by test/bitbucket-webhook.spec.ts for ingestSpy.
const { createSessionSpy } = vi.hoisted(() => ({ createSessionSpy: vi.fn() }));
vi.mock('@server/core/sessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@server/core/sessions')>();
  return {
    ...actual,
    createSession: async (...args: Parameters<typeof actual.createSession>) => {
      createSessionSpy(...args);
      return actual.createSession(...args);
    },
  };
});

function buildTestApp() {
  const app = new Hono<AppEnv>();
  app.route('/auth', createAuthBitbucketRouter());
  return app;
}

function buildTestEnv(overrides: Record<string, unknown> = {}) {
  return {
    APP_KV: new MemoryKV() as unknown as KVNamespace,
    BITBUCKET_CLIENT_ID: 'test-bitbucket-client-id',
    BITBUCKET_CLIENT_SECRET: 'test-bitbucket-client-secret',
    BITBUCKET_AUTH_CALLBACK_URL: 'http://localhost:8787/auth/bitbucket/callback',
    DASHBOARD_ALLOWED_USERS: '{"bitbucket":["557058:on-list"]}',
    ...overrides,
  } as any;
}

type BitbucketProfileFixture = {
  account_id: string;
  uuid: string;
  username: string;
  display_name: string;
  avatar: string;
  email: string | null;
};

function bitbucketProfileFixture(overrides: Partial<BitbucketProfileFixture> = {}): BitbucketProfileFixture {
  return {
    account_id: '557058:on-list',
    uuid: '{11111111-2222-3333-4444-555555555555}',
    username: 'alice',
    display_name: 'Alice',
    avatar: 'https://bitbucket.org/account/alice/avatar/',
    email: null,
    ...overrides,
  };
}

/** Stubs global fetch for the two Bitbucket OAuth endpoints this route calls. */
function stubBitbucketOAuthFetch(options: {
  tokenStatus?: number;
  tokenBody?: unknown;
  profileBody?: unknown;
}) {
  const { tokenStatus = 200, tokenBody = { access_token: 'bb-access-token' }, profileBody = bitbucketProfileFixture() } = options;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const rawUrl = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
    if (rawUrl.startsWith('https://bitbucket.org/site/oauth2/access_token')) {
      return Response.json(tokenBody as object, { status: tokenStatus });
    }
    if (rawUrl.startsWith('https://api.bitbucket.org/2.0/user')) {
      return Response.json(profileBody as object, { status: 200 });
    }
    throw new Error(`Unexpected fetch in test/auth-allow-list.spec.ts: ${rawUrl}`);
  });
}

describe('routes/auth-bitbucket — D-33 / D-34 / D-35 callback allow-list flow', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    createSessionSpy.mockClear();
  });

  it('GET /auth/bitbucket redirects to the authorize URL with scope=account only (D-34)', async () => {
    const app = buildTestApp();
    const env = buildTestEnv();

    const res = await app.request('/auth/bitbucket', {}, env);

    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    const url = new URL(location);
    expect(`${url.origin}${url.pathname}`).toBe('https://bitbucket.org/site/oauth2/authorize');
    expect(url.searchParams.get('client_id')).toBe(env.BITBUCKET_CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(env.BITBUCKET_AUTH_CALLBACK_URL);
    expect(url.searchParams.get('scope')).toBe('account');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(location).not.toContain('scope=pullrequest');
    expect(location).not.toContain('scope=workspace');
    expect(location).not.toContain('scope=repository');
  });

  it('GET /auth/bitbucket/callback without code or state redirects to /login?error=invalid_callback', async () => {
    const app = buildTestApp();
    const env = buildTestEnv();

    const res = await app.request('/auth/bitbucket/callback', {}, env);

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login?error=invalid_callback');
  });

  it('GET /auth/bitbucket/callback with a state not present in APP_KV redirects to /login?error=invalid_state', async () => {
    const app = buildTestApp();
    const env = buildTestEnv();

    const res = await app.request('/auth/bitbucket/callback?code=test-code&state=not-a-real-state', {}, env);

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login?error=invalid_state');
  });

  it('denies an account_id not on the allow-list, keyed on account_id (not username) (D-28/D-35)', async () => {
    const app = buildTestApp();
    const env = buildTestEnv();
    const state = await createOAuthState(env);
    stubBitbucketOAuthFetch({
      profileBody: bitbucketProfileFixture({ account_id: '557058:not-on-list', username: 'alice-not-on-list' }),
    });

    const res = await app.request(`/auth/bitbucket/callback?code=test-code&state=${state}`, {}, env);

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login?error=bitbucket_not_allowed');
    expect(createSessionSpy).not.toHaveBeenCalled();
  });

  it('allows an account_id on the allow-list, creates a session, and redirects to /dashboard (D-26)', async () => {
    const app = buildTestApp();
    const env = buildTestEnv();
    const state = await createOAuthState(env);
    stubBitbucketOAuthFetch({ profileBody: bitbucketProfileFixture({ account_id: '557058:on-list' }) });

    const res = await app.request(`/auth/bitbucket/callback?code=test-code&state=${state}`, {}, env);

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/dashboard');
    expect(createSessionSpy).toHaveBeenCalledTimes(1);
    const [, sessionArg] = createSessionSpy.mock.calls[0];
    expect(sessionArg).toMatchObject({
      provider: 'bitbucket',
      accountId: '557058:on-list',
      uuid: '{11111111-2222-3333-4444-555555555555}',
      username: 'alice',
      displayName: 'Alice',
      avatarUrl: 'https://bitbucket.org/account/alice/avatar/',
      email: null,
    });
    expect(typeof sessionArg.signedInAt).toBe('string');
  });

  it('classifies a token-exchange invalid_grant error into /login?error=invalid_grant (D-35)', async () => {
    const app = buildTestApp();
    const env = buildTestEnv();
    const state = await createOAuthState(env);
    stubBitbucketOAuthFetch({
      tokenStatus: 200,
      tokenBody: {
        error: 'invalid_grant',
        error_description: 'invalid_grant: the provided authorization code is expired',
      },
    });

    const res = await app.request(`/auth/bitbucket/callback?code=test-code&state=${state}`, {}, env);

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login?error=invalid_grant');
  });
});
