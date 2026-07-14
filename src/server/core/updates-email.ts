import type { AppBindings } from '@server/env';

const EMAILS_API_URL = 'https://codra.run/api/emails';

type UpdatesEmailRecord = {
  status: 'subscribed';
  email: string;
  updatedAt: string;
};

type UpdatesEmailProvider = 'github' | 'bitbucket';

// D-29 LOCKED: KV key format widened from `updates-email:${githubUserId}` to
// `updates-email:${provider}:${id}` so a GitHub numeric id and a Bitbucket account_id can
// never collide under the same key namespace. Legacy 2/3-arg GitHub-only callers (numeric
// first arg) resolve to the SAME key shape as the widened (provider, id) call style, so both
// call styles stay mutually consistent (test/api.spec.ts:323-324, NREG-02).
//
// This does NOT preserve already-persisted KV data: any key written before this phase under the
// old `updates-email:${githubUserId}` format (no provider segment) is orphaned and unreachable
// under the new format. That is an intentional, accepted tradeoff (06-RESEARCH.md Pitfall 4 /
// Open Question 4) — no migration or dual-read fallback is written. Affected users see
// `status: 'pending'` once and simply re-subscribe on next login.
function updatesEmailKey(providerOrGithubUserId: UpdatesEmailProvider | number, idOrUndefined?: string | number) {
  if (typeof providerOrGithubUserId === 'number') {
    const githubUserId = providerOrGithubUserId;
    return `updates-email:github:${githubUserId}`;
  }
  const provider = providerOrGithubUserId;
  const id = idOrUndefined;
  return `updates-email:${provider}:${id}`;
}

// --- getUpdatesEmailPreference overloads ---
// Overload 1: legacy GitHub-only signature (keeps existing call sites compiling).
export function getUpdatesEmailPreference(
  env: Pick<AppBindings, 'APP_KV'>,
  githubUserId: number,
): Promise<UpdatesEmailRecord | null>;
// Overload 2: provider-discriminator signature (D-29 widened).
export function getUpdatesEmailPreference(
  env: Pick<AppBindings, 'APP_KV'>,
  provider: UpdatesEmailProvider,
  id: string | number,
): Promise<UpdatesEmailRecord | null>;
export async function getUpdatesEmailPreference(
  env: Pick<AppBindings, 'APP_KV'>,
  providerOrGithubUserId: UpdatesEmailProvider | number,
  id?: string | number,
): Promise<UpdatesEmailRecord | null> {
  const key = typeof providerOrGithubUserId === 'number'
    ? updatesEmailKey(providerOrGithubUserId)
    : updatesEmailKey(providerOrGithubUserId, id);
  return await env.APP_KV.get(key, 'json') as UpdatesEmailRecord | null;
}

// --- hasUpdatesEmailPreference overloads ---
// Overload 1: legacy GitHub-only signature (keeps existing call sites compiling).
export function hasUpdatesEmailPreference(
  env: Pick<AppBindings, 'APP_KV'>,
  githubUserId: number,
): Promise<boolean>;
// Overload 2: provider-discriminator signature (D-29 widened).
export function hasUpdatesEmailPreference(
  env: Pick<AppBindings, 'APP_KV'>,
  provider: UpdatesEmailProvider,
  id: string | number,
): Promise<boolean>;
export async function hasUpdatesEmailPreference(
  env: Pick<AppBindings, 'APP_KV'>,
  providerOrGithubUserId: UpdatesEmailProvider | number,
  id?: string | number,
): Promise<boolean> {
  if (typeof providerOrGithubUserId === 'number') {
    return Boolean(await getUpdatesEmailPreference(env, providerOrGithubUserId));
  }
  return Boolean(await getUpdatesEmailPreference(env, providerOrGithubUserId, id as string | number));
}

// --- syncUpdatesEmail overloads ---
// Overload 1: legacy GitHub-only signature (keeps test/api.spec.ts:323-324 compiling, NREG-02).
export function syncUpdatesEmail(
  env: Pick<AppBindings, 'APP_KV'>,
  githubUserId: number,
  email: string | null | undefined,
): Promise<boolean>;
// Overload 2: provider-discriminator signature (D-29 widened).
export function syncUpdatesEmail(
  env: Pick<AppBindings, 'APP_KV'>,
  provider: UpdatesEmailProvider,
  id: string | number,
  email: string | null | undefined,
): Promise<boolean>;
export async function syncUpdatesEmail(
  env: Pick<AppBindings, 'APP_KV'>,
  providerOrGithubUserId: UpdatesEmailProvider | number,
  idOrEmail: string | number | null | undefined,
  emailArg?: string | null | undefined,
): Promise<boolean> {
  const isLegacy = typeof providerOrGithubUserId === 'number';
  const email = isLegacy ? (idOrEmail as string | null | undefined) : emailArg;
  const key = isLegacy
    ? updatesEmailKey(providerOrGithubUserId as number)
    : updatesEmailKey(providerOrGithubUserId as UpdatesEmailProvider, idOrEmail as string | number);

  if (!email) return false;

  const alreadySubscribed = isLegacy
    ? await hasUpdatesEmailPreference(env, providerOrGithubUserId as number)
    : await hasUpdatesEmailPreference(env, providerOrGithubUserId as UpdatesEmailProvider, idOrEmail as string | number);
  if (alreadySubscribed) return false;

  const response = await fetch(EMAILS_API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });

  if (!response.ok) return false;

  const record: UpdatesEmailRecord = {
    status: 'subscribed',
    email,
    updatedAt: new Date().toISOString(),
  };
  await env.APP_KV.put(key, JSON.stringify(record));

  return true;
}
