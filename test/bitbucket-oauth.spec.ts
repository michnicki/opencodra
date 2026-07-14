import { describe, it, expect, vi, afterEach } from 'vitest';

// RED (Wave 0): `@server/core/bitbucket-oauth` does not exist yet — it lands in Wave 2
// (06-03-PLAN.md), mirroring `core/github-oauth.ts` exactly (D-33). This import is expected to
// fail to resolve at collection time; that missing-module signal IS the acceptance criterion for
// this plan. Do NOT create the module here (mirrors the Phase 4 Wave 0 import-based RED
// precedent, `.planning/phases/04-bitbucket-bot-auth-credential-storage/04-01-PLAN.md` Task 1).
//
// Cross-wave dependency note: `toDashboardSessionUser`'s return value is expected to satisfy
// Wave 1's `dashboardSessionUserSchema` Bitbucket variant (D-26) once both waves have landed;
// until Wave 1 lands this is a pure structural-shape assertion against the mapper's own output.
import {
  exchangeBitbucketOAuthCode,
  fetchBitbucketOAuthProfile,
  toDashboardSessionUser,
} from '@server/core/bitbucket-oauth';

const env = {
  BITBUCKET_CLIENT_ID: 'test-bitbucket-client-id',
  BITBUCKET_CLIENT_SECRET: 'test-bitbucket-client-secret',
  BITBUCKET_AUTH_CALLBACK_URL: 'http://localhost:8787/auth/bitbucket/callback',
};

type RecordedCall = { url: string; method: string; headers: Headers; body: string | null };

/** Stubs global fetch for a single scripted response, mirroring test/github-fetch-mock.ts's shape. */
function stubFetchOnce(status: number, body: unknown) {
  const calls: RecordedCall[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
    calls.push({
      url: rawUrl,
      method: (init?.method ?? 'GET').toUpperCase(),
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : null,
    });
    return typeof body === 'string'
      ? new Response(body, { status })
      : Response.json(body as object, { status });
  });
  return calls;
}

describe('core/bitbucket-oauth — D-33 / D-34 / Pitfall 3', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('exchangeBitbucketOAuthCode issues HTTP Basic auth on POST /site/oauth2/access_token (D-34)', async () => {
    const calls = stubFetchOnce(200, { access_token: 'bb-access-token' });

    await exchangeBitbucketOAuthCode(env, 'test-code');

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.method).toBe('POST');
    expect(call.url).toBe('https://bitbucket.org/site/oauth2/access_token');
    // HTTP Basic auth on the client credentials -- NEVER a form-param client_secret (D-34).
    expect(call.headers.get('Authorization')).toBe(
      `Basic ${btoa(`${env.BITBUCKET_CLIENT_ID}:${env.BITBUCKET_CLIENT_SECRET}`)}`,
    );
    expect(call.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    // Parse via URLSearchParams rather than a raw string match so percent-encoding of
    // redirect_uri (colons/slashes) does not make this assertion brittle.
    const params = new URLSearchParams(call.body ?? '');
    expect(params.get('grant_type')).toBe('authorization_code');
    expect(params.get('code')).toBe('test-code');
    expect(params.get('redirect_uri')).toBe(env.BITBUCKET_AUTH_CALLBACK_URL);
    expect(params.has('client_secret')).toBe(false);
  });

  it('resolves to the access_token string on a 200 OK response', async () => {
    stubFetchOnce(200, { access_token: 'bb-access-token' });
    const token = await exchangeBitbucketOAuthCode(env, 'test-code');
    expect(token).toBe('bb-access-token');
  });

  it('rejects with an Error containing the status code on a non-2xx response', async () => {
    stubFetchOnce(401, {});
    await expect(exchangeBitbucketOAuthCode(env, 'test-code')).rejects.toThrow('401');
  });

  it('rejects with an Error containing error_description when access_token is missing (200)', async () => {
    stubFetchOnce(200, { error: 'invalid_grant', error_description: 'The authorization code has expired.' });
    await expect(exchangeBitbucketOAuthCode(env, 'test-code')).rejects.toThrow('The authorization code has expired.');
  });

  it('fetchBitbucketOAuthProfile issues a Bearer GET to /2.0/user', async () => {
    const calls = stubFetchOnce(200, {
      account_id: '557058:1bb1b1aa-aaaa-bbbb-cccc-ddddeeeeffff',
      uuid: '{11111111-2222-3333-4444-555555555555}',
      username: 'alice',
      display_name: 'Alice',
      email: null,
    });

    await fetchBitbucketOAuthProfile('bb-access-token');

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.method).toBe('GET');
    expect(call.url).toBe('https://api.bitbucket.org/2.0/user');
    expect(call.headers.get('Authorization')).toBe('Bearer bb-access-token');
  });

  it('toDashboardSessionUser maps the Bitbucket variant shape, resolving avatarUrl via the mapper\'s own precedence (Pitfall 3)', () => {
    const profile = {
      account_id: '557058:1bb1b1aa-aaaa-bbbb-cccc-ddddeeeeffff',
      uuid: '{11111111-2222-3333-4444-555555555555}',
      username: 'alice',
      display_name: 'Alice',
      avatar: 'https://bitbucket.org/account/alice/avatar-top-level/',
      links: { avatar: { href: 'https://bitbucket.org/account/alice/avatar-links/' } },
      email: null,
    };

    const mapped = toDashboardSessionUser(profile);

    expect(mapped.provider).toBe('bitbucket');
    if (mapped.provider !== 'bitbucket') throw new Error('expected bitbucket variant');
    expect(mapped.accountId).toBe(profile.account_id);
    expect(mapped.uuid).toBe(profile.uuid);
    expect(mapped.username).toBe(profile.username);
    expect(mapped.displayName).toBe(profile.display_name);
    expect(mapped.email).toBe(profile.email);
    expect(typeof mapped.signedInAt).toBe('string');
    expect(() => new Date(mapped.signedInAt).toISOString()).not.toThrow();
    // Do NOT hardcode which field wins -- assert against the mapper's own chosen precedence
    // (the real Bitbucket /2.0/user response shape is unverified per Pitfall 3).
    expect(mapped.avatarUrl).toBe(profile.links?.avatar?.href ?? profile.avatar ?? null);
  });

  it('toDashboardSessionUser falls back to the top-level avatar field when links.avatar is absent', () => {
    const profile = {
      account_id: '557058:1bb1b1aa-aaaa-bbbb-cccc-ddddeeeeffff',
      uuid: '{11111111-2222-3333-4444-555555555555}',
      username: 'alice',
      display_name: 'Alice',
      avatar: 'https://bitbucket.org/account/alice/avatar-top-level/',
      email: null,
    };

    const mapped = toDashboardSessionUser(profile);
    expect(mapped.avatarUrl).toBe(profile.avatar);
  });
});
