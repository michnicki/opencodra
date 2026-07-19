import type { AppBindings } from '@server/env';

/**
 * Cached bot-identity resolver (SC4 / NREG-02).
 *
 * Resolves the bot's OWN identity so a later phase can self-filter the bot's own comments and
 * defuse the latent echo loop (`services/formatter.ts` embeds `@${botUsername} review` in the
 * summary — without identity resolution the bot could re-trigger itself).
 *
 * `login` seeds synchronously from `env.BOT_USERNAME` (the existing `"codraapp"` binding) — the
 * mutable @mention handle. `accountId` is the IMMUTABLE id the Phase 11 self-filter keys on
 * (NREG-02) — a username can be renamed, an account id cannot.
 *
 * **Recorded decision — discovery deferred to Phase 11 (RESEARCH #3 / Open Q1).** This phase has
 * NO consumer: neither the GitHub nor the Bitbucket client has a token source or an identity-fetch
 * method wired here, so a real `accountId` CANNOT be resolved in Phase 7 without building live
 * discovery that belongs to Phase 11. Adding net-new live-discovery client methods with no consumer
 * would be speculative surface. Therefore `accountId` is nullable: a seed-only result carries
 * `accountId: null`. This is an INTENTIONAL, documented nullable contract, not a silent SC4
 * weakening. No `APP_BOT_NAME` env var is introduced (D-10 supersedes the ROADMAP wording).
 */

/**
 * Narrow discovery interface an authenticated client implements to resolve the bot's immutable id.
 * Phase 11 supplies a real implementation (Bitbucket `GET /user` → `account_id`, GitHub bot-user-id
 * fetch). This phase adds NO live method to either client — only mocked-client unit tests exercise
 * the cold-cache discovery path.
 */
export interface BotIdentityResolver {
  resolveIdentity(): Promise<{ accountId: string; login?: string }>;
}

export type VcsProviderName = 'github' | 'bitbucket';

export interface BotIdentity {
  login: string;
  accountId: string | null;
  provider: VcsProviderName;
}

/** KV key for the per-provider bot-identity cache. Bot identity is stable, so no TTL is set. */
function botIdentityCacheKey(provider: VcsProviderName): string {
  return `bot-identity:${provider}`;
}

type CachedBotIdentity = { login: string; accountId: string | null };

/**
 * Resolve the bot's identity for `provider`, reading through the `APP_KV` cache keyed on
 * `bot-identity:${provider}`. Mirrors the `getAppInstallationUrl` KV read/put pattern
 * (`core/github.ts`).
 *
 * - Cache HIT → returns the cached `{ login, accountId, provider }` (client, if any, not called).
 * - Cache MISS with a `client` → resolves `accountId` via `client.resolveIdentity()`, writes it to
 *   `APP_KV`, and returns it.
 * - Cache MISS with NO `client` (the Phase 7 reality — no consumer) → returns the seed-only
 *   `{ login: <BOT_USERNAME>, accountId: null, provider }` WITHOUT throwing.
 *
 * The `provider` field is included in the returned object for correlation (OpenCode suggestion #3).
 */
export async function getBotIdentity(
  env: Pick<AppBindings, 'APP_KV' | 'BOT_USERNAME'>,
  provider: VcsProviderName,
  client?: BotIdentityResolver,
): Promise<BotIdentity> {
  // login seeds synchronously from the existing BOT_USERNAME binding — the mutable @mention handle.
  const login = env.BOT_USERNAME;
  const cacheKey = botIdentityCacheKey(provider);

  const cachedRaw = await env.APP_KV.get(cacheKey);
  if (cachedRaw) {
    const cached = JSON.parse(cachedRaw) as CachedBotIdentity;
    // Prefer the cached login if present, but fall back to the current BOT_USERNAME.
    return { login: cached.login ?? login, accountId: cached.accountId ?? null, provider };
  }

  if (client) {
    // Cold cache with an authenticated client: resolve the immutable accountId and cache it.
    const resolved = await client.resolveIdentity();
    const identity: BotIdentity = {
      login: resolved.login ?? login,
      accountId: resolved.accountId,
      provider,
    };
    await env.APP_KV.put(
      cacheKey,
      JSON.stringify({ login: identity.login, accountId: identity.accountId } satisfies CachedBotIdentity),
    );
    return identity;
  }

  // Seed-only result: no cached id and no client to discover one (the EXPLICIT Phase-11 deferral).
  // Phase-11 hand-off (NREG-02): the self-filter consumer MUST require a NON-NULL accountId before
  // keying on it — a seed-only `{ accountId: null }` MUST NOT be used as a self-filter key, or the
  // immutable-id echo-loop defense is silently lost.
  return { login, accountId: null, provider };
}
