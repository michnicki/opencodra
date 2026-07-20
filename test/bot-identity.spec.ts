import { describe, expect, it, vi } from 'vitest';
import { getBotIdentity, type BotIdentityResolver } from '@server/core/bot-identity';
import { createBitbucketBotIdentityResolver } from '@server/core/bitbucket';
import { createTestEnv } from './helpers';

// SC4 / NREG-02: getBotIdentity seeds `login` from BOT_USERNAME and reads/caches the immutable
// `accountId` in APP_KV under `bot-identity:${provider}`, returning { login, accountId, provider }.
// These are unit tests (no DB, no Postgres) running in the `node` vitest project against the
// mocked MemoryKV APP_KV binding from test/helpers.ts.

describe('getBotIdentity', () => {
  it('seed-only cold cache with no client returns accountId null without throwing', async () => {
    const env = createTestEnv();

    const identity = await getBotIdentity(env, 'github');

    expect(identity).toEqual({
      login: env.BOT_USERNAME,
      accountId: null,
      provider: 'github',
    });
  });

  it('returns the cached accountId on a cache hit without invoking the client', async () => {
    const env = createTestEnv();
    await env.APP_KV.put(
      'bot-identity:github',
      JSON.stringify({ login: 'cached-login', accountId: 'acct-immutable-123' }),
    );
    const client: BotIdentityResolver = {
      resolveIdentity: vi.fn(async () => ({ accountId: 'should-not-be-used' })),
    };

    const identity = await getBotIdentity(env, 'github', client);

    expect(identity.accountId).toBe('acct-immutable-123');
    expect(identity.provider).toBe('github');
    expect(client.resolveIdentity).not.toHaveBeenCalled();
  });

  it('WR-02: a corrupt cache value is treated as a miss and falls through to the seed path (no throw)', async () => {
    const env = createTestEnv();
    // A non-JSON value at the cache key would make an unguarded JSON.parse throw and abort
    // resolution. The guard must treat it as a miss and return the seed-only identity.
    await env.APP_KV.put('bot-identity:github', '{ this is not valid json');

    const identity = await getBotIdentity(env, 'github');

    expect(identity).toEqual({
      login: env.BOT_USERNAME,
      accountId: null,
      provider: 'github',
    });
  });

  it('WR-02: a corrupt cache value falls through to the client discovery path when a client is supplied', async () => {
    const env = createTestEnv();
    await env.APP_KV.put('bot-identity:github', 'not-json-at-all');
    const client: BotIdentityResolver = {
      resolveIdentity: vi.fn(async () => ({ accountId: 'recovered-acct-456', login: 'recovered-login' })),
    };

    const identity = await getBotIdentity(env, 'github', client);

    expect(identity.accountId).toBe('recovered-acct-456');
    expect(client.resolveIdentity).toHaveBeenCalledOnce();
    // The poisoned entry self-heals: a subsequent read returns the re-`put` valid value.
    const second = await getBotIdentity(env, 'github');
    expect(second.accountId).toBe('recovered-acct-456');
  });

  it('resolves accountId via the client on a cold cache and puts it under bot-identity:github', async () => {
    const env = createTestEnv();
    const putSpy = vi.spyOn(env.APP_KV, 'put');
    const client: BotIdentityResolver = {
      resolveIdentity: vi.fn(async () => ({ accountId: 'resolved-acct-789', login: 'resolved-login' })),
    };

    const identity = await getBotIdentity(env, 'github', client);

    expect(identity).toEqual({
      login: 'resolved-login',
      accountId: 'resolved-acct-789',
      provider: 'github',
    });
    expect(client.resolveIdentity).toHaveBeenCalledOnce();
    expect(putSpy).toHaveBeenCalledWith(
      'bot-identity:github',
      expect.stringContaining('resolved-acct-789'),
    );

    // The written value must round-trip on a subsequent read (cache is now warm).
    const second = await getBotIdentity(env, 'github');
    expect(second.accountId).toBe('resolved-acct-789');
  });

  it('LAYER 1: a resolveIdentity() throw degrades to accountId null, does not throw, and is NOT cached', async () => {
    const env = createTestEnv();
    const putSpy = vi.spyOn(env.APP_KV, 'put');
    const client: BotIdentityResolver = {
      resolveIdentity: vi.fn(async () => {
        throw new Error('403');
      }),
    };

    const identity = await getBotIdentity(env, 'bitbucket', client, { workspace: 'ws', repo: 'r' });

    expect(identity).toEqual({
      login: env.BOT_USERNAME,
      accountId: null,
      provider: 'bitbucket',
    });
    expect(client.resolveIdentity).toHaveBeenCalledOnce();
    // Fail-closed + not cached: a thrown resolution must never reach the KV put (no poisoned cache).
    expect(putSpy).not.toHaveBeenCalled();
  });

  it('scopes the Bitbucket cache key per repository so two repos do not share a cached identity', async () => {
    const env = createTestEnv();
    const clientA: BotIdentityResolver = {
      resolveIdentity: vi.fn(async () => ({ accountId: 'acct-repoA', login: 'bot' })),
    };
    const clientB: BotIdentityResolver = {
      resolveIdentity: vi.fn(async () => ({ accountId: 'acct-repoB', login: 'bot' })),
    };

    const idA = await getBotIdentity(env, 'bitbucket', clientA, { workspace: 'ws', repo: 'repoA' });
    const idB = await getBotIdentity(env, 'bitbucket', clientB, { workspace: 'ws', repo: 'repoB' });

    expect(idA.accountId).toBe('acct-repoA');
    expect(idB.accountId).toBe('acct-repoB');
    // repoB does NOT read repoA's cached identity — its own client is invoked (per-repo tokens).
    expect(clientB.resolveIdentity).toHaveBeenCalledOnce();

    // Each identity is cached under a DISTINCT repo-scoped key.
    expect(await env.APP_KV.get('bot-identity:bitbucket:ws/repoA')).toContain('acct-repoA');
    expect(await env.APP_KV.get('bot-identity:bitbucket:ws/repoB')).toContain('acct-repoB');
    // The bare (unscoped) Bitbucket key was NOT written for a scoped call.
    expect(await env.APP_KV.get('bot-identity:bitbucket')).toBeNull();
  });

  it('keeps the GitHub cache key installation-global (bot-identity:github) — scope does not apply', async () => {
    const env = createTestEnv();
    const client: BotIdentityResolver = {
      resolveIdentity: vi.fn(async () => ({ accountId: 'gh-acct', login: 'bot' })),
    };

    await getBotIdentity(env, 'github', client);

    expect(await env.APP_KV.get('bot-identity:github')).toContain('gh-acct');
  });
});

describe('createBitbucketBotIdentityResolver (CMD-07 Layer 2)', () => {
  it('returns the configured account_id WITHOUT calling resolveBotUserIdentity', async () => {
    const client = { resolveBotUserIdentity: vi.fn(async () => ({ accountId: 'from-get-user' })) };

    const resolver = createBitbucketBotIdentityResolver(client, 'configured-acct');
    const resolved = await resolver.resolveIdentity();

    expect(resolved).toEqual({ accountId: 'configured-acct' });
    // A Repository Access Token 403s on GET /2.0/user — the configured id must avoid that call.
    expect(client.resolveBotUserIdentity).not.toHaveBeenCalled();
  });

  it('delegates to resolveBotUserIdentity when no configured id is supplied', async () => {
    const client = { resolveBotUserIdentity: vi.fn(async () => ({ accountId: 'from-get-user' })) };

    const resolver = createBitbucketBotIdentityResolver(client);
    const resolved = await resolver.resolveIdentity();

    expect(resolved).toEqual({ accountId: 'from-get-user' });
    expect(client.resolveBotUserIdentity).toHaveBeenCalledOnce();
  });
});
