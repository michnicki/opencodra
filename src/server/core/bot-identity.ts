import type { AppBindings } from '@server/env';
import { logger } from '@server/core/logger';

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

/**
 * KV key for the bot-identity cache. Bot identity is stable, so no TTL is set.
 *
 * GitHub is installation-global (`bot-identity:github`): one App identity across all its repos.
 * Bitbucket tokens are PER-REPO, so a scoped call keys on `bot-identity:bitbucket:{workspace}/{repo}`
 * (REVIEW: Codex 11-02 HIGH) — one repo's cached identity must NEVER be reused to authorize another
 * repo. An unscoped Bitbucket call falls back to the bare `bot-identity:bitbucket` key.
 */
function botIdentityCacheKey(
  provider: VcsProviderName,
  scope?: { workspace: string; repo: string },
): string {
  if (provider === 'bitbucket' && scope) {
    return `bot-identity:bitbucket:${scope.workspace}/${scope.repo}`;
  }
  return `bot-identity:${provider}`;
}

type CachedBotIdentity = { login: string; accountId: string | null };

/**
 * Resolve the bot's identity for `provider`, reading through the `APP_KV` cache keyed on
 * `bot-identity:${provider}`. Follows the same KV read/put caching shape as `getAppInstallationUrl`
 * (`core/github.ts`), but note this value is JSON-encoded (`{ login, accountId }`) whereas
 * `getAppInstallationUrl` caches and returns a RAW string — so this path adds a `JSON.parse` the
 * precedent does not have, and guards it (WR-02): a corrupt/legacy-shaped cache entry is treated as
 * a miss and falls through to the client/seed path rather than throwing.
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
  // Optional per-repository scope. REQUIRED for Bitbucket (per-repo tokens) so the cache key is
  // `bot-identity:bitbucket:{workspace}/{repo}` and one repo's identity cannot leak to another
  // (REVIEW: Codex 11-02 HIGH). Ignored for GitHub (installation-global identity).
  scope?: { workspace: string; repo: string },
): Promise<BotIdentity> {
  // login seeds synchronously from the existing BOT_USERNAME binding — the mutable @mention handle.
  const login = env.BOT_USERNAME;
  const cacheKey = botIdentityCacheKey(provider, scope);

  const cachedRaw = await env.APP_KV.get(cacheKey);
  if (cachedRaw) {
    // WR-02: guard the parse. A corrupt or legacy-shaped value would otherwise throw and abort
    // identity resolution with no recovery. On parse failure, treat the entry as a cache MISS and
    // fall through to the client/seed path below so a poisoned cache entry can self-heal (the
    // client path re-`put`s a valid value; the seed path still returns a usable identity).
    try {
      const cached = JSON.parse(cachedRaw) as CachedBotIdentity;
      // Prefer the cached login if present, but fall back to the current BOT_USERNAME.
      return { login: cached.login ?? login, accountId: cached.accountId ?? null, provider };
    } catch {
      logger.warn(`Discarding corrupt bot-identity cache for ${provider}`);
      // fall through to the client/seed path below.
    }
  }

  if (client) {
    // Cold cache with an authenticated client: resolve the immutable accountId and cache it.
    // LAYER 1 (CMD-07, T-sjn-01): a Repository Access Token 403s on Bitbucket `GET /2.0/user`, so
    // resolveIdentity() can throw. Wrap ONLY the resolution call — on throw, warn and degrade to the
    // same seed-only { accountId: null } the no-client path returns, so the webhook returns 200
    // (ignored/identity_unresolved, fail-closed) instead of 500. The failure is NOT cached: the
    // `put` lives after a successful resolution only, so a later attempt can still succeed.
    let resolved: { accountId: string; login?: string };
    try {
      resolved = await client.resolveIdentity();
    } catch (error) {
      logger.warn(
        `Bot-identity resolution failed for ${provider}; degrading to a seed-only identity (accountId: null)`,
        error instanceof Error ? error : new Error(String(error)),
      );
      return { login, accountId: null, provider };
    }
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
