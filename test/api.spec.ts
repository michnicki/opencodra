import { createApp } from '@server/app';
import { insertJob } from '@server/db/jobs';
import { defaultRepoConfig } from '@shared/schema';
import type {
  AuthSessionResponse,
  JobDetailResponse,
  JobsResponse,
  RepoConfigsResponse,
  StatsResponse,
} from '@shared/api';
import { createTestEnv } from './helpers';
import { vi } from 'vitest';

function mockGitHubProfile(login = 'devarshishimpi') {
  return {
    id: 42,
    login,
    name: 'Devarshi Shimpi',
    avatar_url: 'https://avatars.githubusercontent.com/u/42',
    email: null,
  };
}

describe('Dashboard API Suite', () => {
  const app = createApp();

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  async function getAuthCookie(env = createTestEnv(), login = 'devarshishimpi') {
    const originalFetch = globalThis.fetch;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);

      if (url === 'https://github.com/login/oauth/access_token') {
        return Response.json({ access_token: 'oauth-access-token' });
      }

      if (url === 'https://api.github.com/user') {
        return Response.json(mockGitHubProfile(login));
      }

      return originalFetch(input, init);
    });

    const authStart = await app.request('/auth/github', {}, env);
    const authLocation = authStart.headers.get('location');
    expect(authStart.status).toBe(302);
    expect(authLocation).toBeTruthy();

    const state = authLocation ? new URL(authLocation).searchParams.get('state') : null;
    expect(state).toBeTruthy();

    const callback = await app.request(`/auth/github/callback?code=test-code&state=${state}`, {}, env);
    const cookieHeader = callback.headers.get('set-cookie') || '';
    const match = cookieHeader.match(/codra_session=([^;]+)/);

    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('/dashboard');

    return match ? match[1] : '';
  }

  it('denies access to /api/jobs without a session', async () => {
    const env = createTestEnv();
    const response = await app.request('/api/jobs', {}, env);
    expect(response.status).toBe(401);
  });

  it('starts GitHub OAuth with the configured callback and scope', async () => {
    const env = createTestEnv();
    const response = await app.request('/auth/github', {}, env);

    expect(response.status).toBe(302);

    const location = response.headers.get('location');
    expect(location).toBeTruthy();

    const url = new URL(location!);
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe(env.GITHUB_CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(env.AUTH_CALLBACK_URL);
    expect(url.searchParams.get('scope')).toBe('read:user');
    expect(url.searchParams.get('state')).toBeTruthy();
  });

  it('rejects GitHub users outside the allowlist', async () => {
    const env = createTestEnv({ DASHBOARD_ALLOWED_USERS: 'someoneelse' });
    const originalFetch = globalThis.fetch;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === 'https://github.com/login/oauth/access_token') {
        return Response.json({ access_token: 'oauth-access-token' });
      }
      if (url === 'https://api.github.com/user') {
        return Response.json(mockGitHubProfile('devarshishimpi'));
      }
      return originalFetch(input, init);
    });

    const authStart = await app.request('/auth/github', {}, env);
    const state = new URL(authStart.headers.get('location')!).searchParams.get('state');
    const response = await app.request(`/auth/github/callback?code=test-code&state=${state}`, {}, env);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/login?error=not_allowed');
  });

  it('allows access to /api/jobs with a valid GitHub session', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);
    const response = await app.request('/api/jobs', {
      headers: { Cookie: `codra_session=${token}` },
    }, env);

    expect(response.status).toBe(200);
    const data = await response.json() as JobsResponse;
    expect(Array.isArray(data.jobs)).toBe(true);
  });

  it('returns the authenticated GitHub session user', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);

    const response = await app.request('/api/auth/session', {
      headers: { Cookie: `codra_session=${token}` },
    }, env);

    expect(response.status).toBe(200);
    const data = await response.json() as AuthSessionResponse;
    expect(data.user.login).toBe('devarshishimpi');
  });

  it('returns 404 for non-existent job detail (invalid UUID)', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);

    const response = await app.request('/api/jobs/non-existent-id', {
      headers: { Cookie: `codra_session=${token}` },
    }, env);

    expect(response.status).toBe(404);
  });

  it('fetches job details accurately', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);

    const job = await insertJob(env, {
      installationId: '123',
      owner: 'api-test-owner',
      repo: 'api-test-repo',
      prNumber: 42,
      prTitle: 'API Test PR',
      prAuthor: 'tester',
      commitSha: 'sha123',
      baseSha: 'basesha',
      trigger: 'auto',
      headRef: 'main',
      baseRef: 'main',
      configSnapshot: defaultRepoConfig,
    });

    const response = await app.request(`/api/jobs/${job.id}`, {
      headers: { Cookie: `codra_session=${token}` },
    }, env);

    expect(response.status).toBe(200);
    const data = await response.json() as JobDetailResponse;
    expect(data.job.id).toBe(job.id);
    expect(data.job.owner).toBe('api-test-owner');
    expect(data.job.prNumber).toBe(42);
    expect(data.job.files).toBeDefined();
  });

  it('returns stats successfully', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);

    const response = await app.request('/api/stats', {
      headers: { Cookie: `codra_session=${token}` },
    }, env);

    expect(response.status).toBe(200);
    const data = await response.json() as StatsResponse;
    expect(data.stats).toHaveProperty('totals');
    expect(data.stats).toHaveProperty('trend');
    expect(data.stats).toHaveProperty('topRepos');
  });

  it('returns repository list', async () => {
    const env = createTestEnv();
    const token = await getAuthCookie(env);

    const response = await app.request('/api/repos', {
      headers: { Cookie: `codra_session=${token}` },
    }, env);

    expect(response.status).toBe(200);
    const data = await response.json() as RepoConfigsResponse;
    expect(Array.isArray(data.repos)).toBe(true);
  });
});
