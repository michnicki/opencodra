import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Context } from 'hono';
import type { AppBindings, AppEnv } from '@server/env';
import { logger } from '@server/core/logger';

const OAUTH_STATE_TTL_SECONDS = 60 * 10;

// Browser-bound copy of the OAuth `state` value. The KV state (createOAuthState) proves the
// callback originated from an authorize request WE issued; this cookie additionally proves it
// originated from the SAME browser that started the flow — closing the login-CSRF hole where an
// attacker could feed a victim a valid state they minted themselves.
const OAUTH_STATE_COOKIE_NAME = 'codra_oauth_state';
// Scoped to /auth so it is only ever transmitted to the authorize/callback routes.
const OAUTH_STATE_COOKIE_PATH = '/auth';

function randomHex(size = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function oauthStateKey(state: string) {
  return `oauth-state:${state}`;
}

export type AllowedUsersByProvider = { github: Set<string>; bitbucket: Set<string> };

// D-27/D-28/Pitfall 1: DASHBOARD_ALLOWED_USERS is a JSON object keyed by provider,
// e.g. {"github":["devarshishimpi"],"bitbucket":["557058:1bb1b1aa-..."]}. GitHub logins are
// lowercased (case-insensitive); Bitbucket account_id values are preserved byte-identically
// (they are opaque, colon-containing identifiers, NOT case-insensitive usernames). The legacy
// comma-separated format is still accepted for a zero-friction migration (GitHub-only).
export function parseAllowedUsersByProvider(input: string): AllowedUsersByProvider {
  const trimmed = input.trim();

  if (!trimmed) {
    return { github: new Set(), bitbucket: new Set() };
  }

  if (trimmed.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error('DASHBOARD_ALLOWED_USERS: JSON must parse to an object keyed by provider.');
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('DASHBOARD_ALLOWED_USERS: JSON must parse to an object keyed by provider.');
    }

    const record = parsed as Record<string, unknown>;
    const githubEntries = Array.isArray(record.github) ? record.github : [];
    const bitbucketEntries = Array.isArray(record.bitbucket) ? record.bitbucket : [];

    return {
      github: new Set(
        githubEntries
          .map((value) => String(value).trim().toLowerCase())
          .filter(Boolean),
      ),
      bitbucket: new Set(
        bitbucketEntries
          .map((value) => String(value))
          .filter(Boolean),
      ),
    };
  }

  // Escalated from warn to error: the legacy CSV format silently DROPS all Bitbucket
  // allowlisting (bitbucket set is empty below), so a misconfigured deployment would reject
  // every Bitbucket login. Make that loud so an operator notices the migration is required.
  logger.error(
    'DASHBOARD_ALLOWED_USERS uses the legacy comma-separated format; Bitbucket allowlisting is DISABLED. Migrate to JSON: {"github":["..."],"bitbucket":["..."]}.',
  );

  const github = new Set(
    trimmed
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );

  return { github, bitbucket: new Set<string>() };
}

// Bind the freshly-minted state to the caller's browser. HttpOnly (JS cannot read it),
// Secure (localhost is treated as a secure context so this still works in `wrangler dev`),
// SameSite=Lax (sent on the top-level GET redirect back from the provider), short-lived.
export function setOAuthStateCookie(c: Context<AppEnv>, state: string) {
  setCookie(c, OAUTH_STATE_COOKIE_NAME, state, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: OAUTH_STATE_COOKIE_PATH,
    maxAge: OAUTH_STATE_TTL_SECONDS,
  });
}

// Read the browser-bound state and clear it (single-use). Returns null when absent.
export function readAndClearOAuthStateCookie(c: Context<AppEnv>): string | null {
  const value = getCookie(c, OAUTH_STATE_COOKIE_NAME) ?? null;
  deleteCookie(c, OAUTH_STATE_COOKIE_NAME, { path: OAUTH_STATE_COOKIE_PATH });
  return value;
}

function oauthStateConsumedKey(state: string) {
  return `oauth-state-consumed:${state}`;
}

// Fail closed if a deployment's OAuth callback URL does not belong to this app's own origin.
// A mismatched redirect_uri could be pointed at an attacker-controlled host to leak the
// authorization code. Local dev keeps working: http is allowed as long as the origin matches
// APP_URL; https is only mandated in production.
export function assertTrustedCallbackUrl(callbackUrl: string, appUrl: string, environment: string) {
  let callback: URL;
  let app: URL;
  try {
    callback = new URL(callbackUrl);
    app = new URL(appUrl);
  } catch {
    throw new Error('OAuth callback/app URL is not a valid absolute URL.');
  }

  // Only enforce origin/scheme in production. Dev, test, and proxied setups legitimately front
  // the app through a different host/port than APP_URL (wrangler, test fixtures, tunnels), so a
  // strict origin match there breaks legitimate flows. The threat this guards — a misconfigured
  // production deployment leaking the authorization code to an attacker host — is production-only.
  if (environment !== 'production') {
    return;
  }

  if (callback.origin !== app.origin) {
    throw new Error(
      `OAuth callback origin ${callback.origin} does not match APP_URL origin ${app.origin}.`,
    );
  }

  if (callback.protocol !== 'https:') {
    throw new Error('OAuth callback URL must use https in production.');
  }
}

export async function createOAuthState(env: Pick<AppBindings, 'APP_KV'>) {
  const state = randomHex();
  await env.APP_KV.put(
    oauthStateKey(state),
    JSON.stringify({ createdAt: new Date().toISOString() }),
    { expirationTtl: OAUTH_STATE_TTL_SECONDS },
  );
  return state;
}

export async function consumeOAuthState(env: Pick<AppBindings, 'APP_KV'>, state: string) {
  const consumedKey = oauthStateConsumedKey(state);

  // Best-effort replay guard: if we already burned this state, reject even if the primary
  // key still lingers within the non-atomic GET-then-DELETE TOCTOU window below. KV is
  // eventually consistent so this narrows — but does not fully eliminate — a concurrent
  // double-consume; combined with the browser-bound state cookie the residual window is
  // not exploitable for login-CSRF.
  const alreadyConsumed = await env.APP_KV.get(consumedKey);
  if (alreadyConsumed) {
    return false;
  }

  const key = oauthStateKey(state);
  const value = await env.APP_KV.get(key);
  if (!value) {
    return false;
  }

  await env.APP_KV.delete(key);
  await env.APP_KV.put(consumedKey, '1', { expirationTtl: OAUTH_STATE_TTL_SECONDS });
  return true;
}
