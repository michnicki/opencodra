import { describe, it, expect } from 'vitest';
import { createApp } from '@server/app';
import { createTestEnv } from './helpers';

describe('app /health endpoint', () => {
  const env = createTestEnv();
  const app = createApp();

  it('returns 200 JSON {status:"ok"} without a session', async () => {
    const response = await app.request('http://codra.test/health', { method: 'GET' }, env);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
  });

  it('does not redirect the health probe to /login', async () => {
    const response = await app.request('http://codra.test/health', { method: 'GET' }, env);
    expect(response.status).not.toBe(302);
    expect(response.headers.get('location')).toBeNull();
  });
});

describe('app security response headers', () => {
  const env = createTestEnv();
  const app = createApp();

  it('sets the safe security headers on responses', async () => {
    const response = await app.request('http://codra.test/health', { method: 'GET' }, env);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
  });

  it('does not set a Content-Security-Policy header (would break the Vite SPA + Google Fonts)', async () => {
    const response = await app.request('http://codra.test/health', { method: 'GET' }, env);
    expect(response.headers.get('content-security-policy')).toBeNull();
  });
});

describe('app security headers on immutable ASSETS responses (regression)', () => {
  // serveIndex returns c.env.ASSETS.fetch(...), whose headers are IMMUTABLE in the Workers
  // runtime. The security-headers middleware must rebuild the response rather than mutate it in
  // place — otherwise the SPA/HTML routes (/, /login) 500 with "Can't modify immutable headers".
  // The default MockAssets returns a mutable Response, so this mock reproduces the immutability.
  function immutableHtmlResponse() {
    const res = new Response('<!doctype html><title>codra</title>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
    const immutable = new Proxy(res.headers, {
      get(target, prop) {
        if (prop === 'set' || prop === 'append' || prop === 'delete') {
          return () => {
            throw new TypeError("Can't modify immutable headers.");
          };
        }
        const value = (target as unknown as Record<string, unknown>)[prop as string];
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    Object.defineProperty(res, 'headers', { value: immutable, configurable: true });
    return res;
  }

  const env = createTestEnv({ ASSETS: { fetch: async () => immutableHtmlResponse() } as never });
  const app = createApp();

  it('serves / (SPA) with security headers without 500-ing on immutable ASSETS headers', async () => {
    const response = await app.request('http://codra.test/', { method: 'GET' }, env);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    // App-shell must be no-cache so a deploy takes effect immediately (and a bad response
    // can't get stuck in the edge cache).
    expect(response.headers.get('cache-control')).toBe('no-cache');
    await expect(response.text()).resolves.toContain('<!doctype html>');
  });
});
