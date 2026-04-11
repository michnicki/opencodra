import { createApp } from '@server/app';
import { createTestEnv } from './helpers';

describe('createApp auth flow', () => {
  it('redirects unauthenticated HTML requests to /login', async () => {
    const app = createApp();
    const response = await app.request(
      'http://codra.test/',
      {
        headers: {
          accept: 'text/html',
        },
      },
      createTestEnv(),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/login');
  });

  it('returns 401 for unauthenticated API requests', async () => {
    const app = createApp();
    const response = await app.request('http://codra.test/api/jobs', {}, createTestEnv());

    expect(response.status).toBe(401);
  });

  it('creates a session on successful login', async () => {
    const app = createApp();
    const env = createTestEnv();
    const response = await app.request(
      'http://codra.test/auth/login',
      {
        method: 'POST',
        body: JSON.stringify({ password: 'letmein' }),
        headers: { 'content-type': 'application/json' },
      },
      env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('codra_session=');
  });
});
