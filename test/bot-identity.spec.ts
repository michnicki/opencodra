import { describe, expect, it, vi } from 'vitest';
import { getBotIdentity, type BotIdentityResolver } from '@server/core/bot-identity';
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
});
