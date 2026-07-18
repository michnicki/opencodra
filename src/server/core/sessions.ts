import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Context } from 'hono';
import { dashboardSessionUserSchema, type AppEnv, type DashboardSessionUser } from '@server/env';

const SESSION_COOKIE_NAME = 'codra_session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

type SessionRecord = DashboardSessionUser;

function randomHex(size = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function sessionKey(token: string) {
  return `session:${token}`;
}

export function constantTimeEqual(left: string, right: string) {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);

  if (leftBytes.byteLength !== rightBytes.byteLength) {
    return false;
  }

  let result = 0;
  for (let index = 0; index < leftBytes.byteLength; index += 1) {
    result |= leftBytes[index] ^ rightBytes[index];
  }

  return result === 0;
}

export async function createSession(c: Context<AppEnv>, session: SessionRecord) {
  const token = randomHex();

  await c.env.APP_KV.put(sessionKey(token), JSON.stringify(session), {
    expirationTtl: SESSION_TTL_SECONDS,
  });

  setCookie(c, SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: true,
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });

  c.set('sessionToken', token);
  c.set('sessionUser', session);

  return token;
}

// Login rotation: establish the NEW session FIRST (writes KV, sets the cookie + request vars),
// THEN best-effort delete the OLD session's KV entry. The old cookie token is captured before
// createSession overwrites the cookie. This ordering guarantees a user is never left
// unauthenticated if a KV write fails mid-rotation — the opposite of calling destroySession
// (which clears the cookie) before createSession.
export async function rotateSession(c: Context<AppEnv>, session: SessionRecord) {
  const previousToken = getCookie(c, SESSION_COOKIE_NAME) ?? null;
  const token = await createSession(c, session);

  if (previousToken && previousToken !== token) {
    await c.env.APP_KV.delete(sessionKey(previousToken));
  }

  return token;
}

export async function destroySession(c: Context<AppEnv>) {
  const token = getCookie(c, SESSION_COOKIE_NAME);
  if (token) {
    await c.env.APP_KV.delete(sessionKey(token));
  }

  c.set('sessionToken', null);
  c.set('sessionUser', null);

  deleteCookie(c, SESSION_COOKIE_NAME, {
    path: '/',
  });
}

export async function readSession(c: Context<AppEnv>) {
  const token = getCookie(c, SESSION_COOKIE_NAME) ?? null;
  c.set('sessionToken', token);

  if (!token) {
    c.set('sessionUser', null);
    return null;
  }

  // Validate the persisted KV record against the canonical session schema instead of blindly
  // casting untrusted JSON. A malformed, legacy, or tampered record is rejected: purge the KV
  // entry + cookie and treat the request as unauthenticated.
  const raw = await c.env.APP_KV.get(sessionKey(token), 'json');
  const parsed = dashboardSessionUserSchema.safeParse(raw);
  if (!parsed.success) {
    await c.env.APP_KV.delete(sessionKey(token));
    deleteCookie(c, SESSION_COOKIE_NAME, { path: '/' });
    c.set('sessionToken', null);
    c.set('sessionUser', null);
    return null;
  }

  c.set('sessionUser', parsed.data);
  return parsed.data;
}
