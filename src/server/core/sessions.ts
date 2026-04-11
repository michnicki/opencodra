import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Context } from 'hono';
import type { AppEnv } from '@server/env';

const SESSION_COOKIE_NAME = 'codra_session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const encoder = new TextEncoder();

function constantTimeEqual(left: Uint8Array, right: Uint8Array) {
  if (left.byteLength !== right.byteLength) {
    return false;
  }

  let result = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    result |= left[index] ^ right[index];
  }

  return result === 0;
}

function randomHex(size = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function sessionKey(token: string) {
  return `session:${token}`;
}

export async function verifyDashboardPassword(secretPassword: string, password: string) {
  return constantTimeEqual(encoder.encode(secretPassword), encoder.encode(password));
}

export async function createSession(c: Context<AppEnv>) {
  const token = randomHex();

  await c.env.APP_KV.put(
    sessionKey(token),
    JSON.stringify({
      createdAt: new Date().toISOString(),
    }),
    {
      expirationTtl: SESSION_TTL_SECONDS,
    },
  );

  setCookie(c, SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'Strict',
    secure: true,
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });

  return token;
}

export async function destroySession(c: Context<AppEnv>) {
  const token = getCookie(c, SESSION_COOKIE_NAME);
  if (token) {
    await c.env.APP_KV.delete(sessionKey(token));
  }

  deleteCookie(c, SESSION_COOKIE_NAME, {
    path: '/',
  });
}

export async function readSessionToken(c: Context<AppEnv>) {
  const token = getCookie(c, SESSION_COOKIE_NAME) ?? null;
  c.set('sessionToken', token);
  return token;
}

export async function hasValidSession(c: Context<AppEnv>) {
  const token = c.get('sessionToken') ?? (await readSessionToken(c));
  if (!token) {
    return false;
  }

  const session = await c.env.APP_KV.get(sessionKey(token));
  return Boolean(session);
}
