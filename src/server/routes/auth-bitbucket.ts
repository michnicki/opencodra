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
import { constantTimeEqual, rotateSession } from '@server/core/sessions';
import { exchangeBitbucketOAuthCode, fetchBitbucketOAuthProfile, toDashboardSessionUser } from '@server/core/bitbucket-oauth';

function redirectToLogin(reason: string) {
  const params = new URLSearchParams({ error: reason });
  return `/login?${params.toString()}`;
}

export function createAuthBitbucketRouter() {
  const app = new Hono<AppEnv>();

  app.get('/bitbucket', async (c) => {
    try {
      assertTrustedCallbackUrl(c.env.BITBUCKET_AUTH_CALLBACK_URL, c.env.APP_URL, c.env.ENVIRONMENT);
    } catch (err) {
      logger.error('Refusing to start Bitbucket OAuth: untrusted callback URL', err instanceof Error ? err : new Error(String(err)));
      return c.redirect(redirectToLogin('oauth_failed'), 302);
    }

    const state = await createOAuthState(c.env);
    setOAuthStateCookie(c, state);
    const url = new URL('https://bitbucket.org/site/oauth2/authorize');
    url.searchParams.set('client_id', c.env.BITBUCKET_CLIENT_ID);
    url.searchParams.set('redirect_uri', c.env.BITBUCKET_AUTH_CALLBACK_URL);
    url.searchParams.set('scope', 'account');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', state);

    return c.redirect(url.toString(), 302);
  });

  app.get('/bitbucket/callback', async (c) => {
    const error = c.req.query('error');
    if (error) {
      // Do NOT reflect the raw upstream Bitbucket error string into the redirect — map it to a
      // fixed enumerated key, matching the enumerated-key style used in the exception path below.
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
      const token = await exchangeBitbucketOAuthCode(c.env, code);
      const profile = await fetchBitbucketOAuthProfile(token);
      const allowedUsers = parseAllowedUsersByProvider(c.env.DASHBOARD_ALLOWED_USERS);

      // DO NOT lowercase or trim account_id here — Bitbucket account_id is case-sensitive and
      // compared byte-for-byte (Pitfall 1 / D-28); unlike GitHub's profile.login, this value is
      // never normalized.
      if (!allowedUsers.bitbucket.has(profile.account_id)) {
        return c.redirect(redirectToLogin('bitbucket_not_allowed'), 302);
      }

      // Establish the new session before tearing down any old one so a failed rotation never
      // logs the user out (see rotateSession).
      await rotateSession(c, toDashboardSessionUser(profile));
      return c.redirect('/dashboard', 302);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/invalid_grant/i.test(message)) {
        return c.redirect(redirectToLogin('invalid_grant'), 302);
      }
      return c.redirect(redirectToLogin('oauth_failed'), 302);
    }
  });

  return app;
}
