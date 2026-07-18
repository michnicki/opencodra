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
