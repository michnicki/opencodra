import type { AppBindings } from '@server/env';
import { logger } from '@server/core/logger';

const OAUTH_STATE_TTL_SECONDS = 60 * 10;

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

  logger.warn(
    'DASHBOARD_ALLOWED_USERS uses the legacy comma-separated format. Migrate to JSON: {"github":["..."],"bitbucket":["..."]}.',
  );

  const github = new Set(
    trimmed
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );

  return { github, bitbucket: new Set<string>() };
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
  const key = oauthStateKey(state);
  const value = await env.APP_KV.get(key);
  if (!value) {
    return false;
  }

  await env.APP_KV.delete(key);
  return true;
}
