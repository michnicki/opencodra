import { Hono } from 'hono';
import type { AppEnv } from '@server/env';
import { logger } from '@server/core/logger';
import {
  createOAuthState,
  consumeOAuthState,
  parseAllowedUsersByProvider,
  setOAuthStateCookie,
  readAndClearOAuthStateCookie,
  assertTrustedCallbackUrl,
} from '@server/core/oauth';
import { constantTimeEqual, destroySession, rotateSession } from '@server/core/sessions';
import { exchangeGitHubOAuthCode, fetchGitHubOAuthProfile, toDashboardSessionUser } from '@server/core/github-oauth';

function redirectToLogin(reason: string) {
  const params = new URLSearchParams({ error: reason });
  return `/login?${params.toString()}`;
}

export function createAuthRouter() {
  const app = new Hono<AppEnv>();

  app.get('/github', async (c) => {
    try {
      assertTrustedCallbackUrl(c.env.AUTH_CALLBACK_URL, c.env.APP_URL, c.env.ENVIRONMENT);
    } catch (err) {
      logger.error('Refusing to start GitHub OAuth: untrusted callback URL', err instanceof Error ? err : new Error(String(err)));
      return c.redirect(redirectToLogin('oauth_failed'), 302);
    }

    const state = await createOAuthState(c.env);
    setOAuthStateCookie(c, state);
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', c.env.GITHUB_CLIENT_ID);
    url.searchParams.set('redirect_uri', c.env.AUTH_CALLBACK_URL);
    url.searchParams.set('scope', 'read:user');
    url.searchParams.set('state', state);

    return c.redirect(url.toString(), 302);
  });

  app.get('/github/callback', async (c) => {
    const error = c.req.query('error');
    if (error) {
      // Do NOT reflect the raw upstream error string into the redirect (it is attacker-
      // influenced); map any present error to a fixed enumerated key.
      return c.redirect(redirectToLogin('oauth_failed'), 302);
    }

    const code = c.req.query('code')?.trim();
    const state = c.req.query('state')?.trim();
    if (!code || !state) {
      return c.redirect(redirectToLogin('invalid_callback'), 302);
    }

    // Login-CSRF defense: the state must match the value bound to THIS browser at authorize
    // time. Read+clear the cookie and compare (constant-time) before consuming the KV state.
    const cookieState = readAndClearOAuthStateCookie(c);
    if (!cookieState || !constantTimeEqual(cookieState, state)) {
      return c.redirect(redirectToLogin('invalid_state'), 302);
    }

    const stateMatches = await consumeOAuthState(c.env, state);
    if (!stateMatches) {
      return c.redirect(redirectToLogin('invalid_state'), 302);
    }

    try {
      const token = await exchangeGitHubOAuthCode(c.env, code);
      const profile = await fetchGitHubOAuthProfile(token);
      const allowedUsers = parseAllowedUsersByProvider(c.env.DASHBOARD_ALLOWED_USERS);

      if (!allowedUsers.github.has(profile.login.toLowerCase())) {
        return c.redirect(redirectToLogin('not_allowed'), 302);
      }

      // Establish the new session before tearing down any old one (rotateSession captures the
      // old cookie token first, creates the new session, then deletes the old KV entry) so a
      // failed rotation never logs the user out.
      await rotateSession(c, toDashboardSessionUser(profile));
      return c.redirect('/dashboard', 302);
    } catch {
      return c.redirect(redirectToLogin('oauth_failed'), 302);
    }
  });

  app.post('/logout', async (c) => {
    await destroySession(c);
    return c.json({ ok: true });
  });

  return app;
}
