import type { AppBindings, DashboardSessionUser } from '@server/env';
import { bitbucketOAuthProfileSchema, type BitbucketOAuthProfile } from '@shared/bitbucket';

export type { BitbucketOAuthProfile };

function bitbucketHeaders(token?: string) {
  return {
    Accept: 'application/json',
    'User-Agent': 'codra-app',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export async function exchangeBitbucketOAuthCode(
  env: Pick<AppBindings, 'BITBUCKET_CLIENT_ID' | 'BITBUCKET_CLIENT_SECRET' | 'BITBUCKET_AUTH_CALLBACK_URL'>,
  code: string,
) {
  const response = await fetch('https://bitbucket.org/site/oauth2/access_token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${env.BITBUCKET_CLIENT_ID}:${env.BITBUCKET_CLIENT_SECRET}`)}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: env.BITBUCKET_AUTH_CALLBACK_URL,
    }).toString(),
  });

  if (!response.ok) {
    throw new Error(`Bitbucket token exchange failed with ${response.status}`);
  }

  const payload = await response.json() as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };

  if (!payload.access_token) {
    throw new Error(payload.error_description ?? payload.error ?? 'Bitbucket token exchange did not return an access token.');
  }

  return payload.access_token;
}

export async function fetchBitbucketOAuthProfile(token: string): Promise<BitbucketOAuthProfile> {
  const response = await fetch('https://api.bitbucket.org/2.0/user', {
    headers: bitbucketHeaders(token),
  });

  if (!response.ok) {
    throw new Error(`Bitbucket user lookup failed with ${response.status}`);
  }

  const parsed = bitbucketOAuthProfileSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error(`Bitbucket user lookup returned an unexpected shape: ${parsed.error.message}`);
  }

  return parsed.data;
}

export function toDashboardSessionUser(profile: BitbucketOAuthProfile): DashboardSessionUser {
  return {
    provider: 'bitbucket' as const,
    accountId: profile.account_id,
    uuid: profile.uuid,
    username: profile.username,
    displayName: profile.display_name,
    avatarUrl: profile.links?.avatar?.href ?? profile.avatar ?? null,
    email: profile.email ?? null,
    signedInAt: new Date().toISOString(),
  };
}
