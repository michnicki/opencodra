import type { AppBindings } from '@server/env';
import { queryRows } from './client';
import {
  vcsCredentialStatusSchema,
  type CredentialStatus,
  type VcsCredentialStatus,
} from '@shared/schema';

// SINGLE SOURCE OF TRUTH for the "expiring soon" warning window (D-05 / review finding 13b).
// 14 days: the actionable rotation window for a Bitbucket bot access token -- long enough that an
// operator can rotate before expiry during a normal work cycle, short enough that a "valid" badge
// stays trustworthy. Status is computed server-side (computeCredentialStatus below) and the redacted
// DTO carries the precomputed `status`; the UI panel (Plan 05) only RENDERS that value and never
// re-derives the threshold, so this constant cannot drift between server and client. Kept as a named
// exported constant (house style for tuned values) so it is unit-testable and has one definition.
export const EXPIRING_SOON_THRESHOLD_MS = 14 * 24 * 60 * 60 * 1000;

// Raw row shape for the vcs_credentials table (migration 004). Secrets are stored/read as ciphertext
// only; the encrypted_* columns never leave this module except through getVcsCredentialSecrets, which
// is internal-only (decrypt/rotate) and must never be serialized into a response (D-10 / T-04-01).
type VcsCredentialRow = {
  vcs_provider: 'github' | 'bitbucket';
  workspace: string;
  repo_slug: string;
  encrypted_access_token: string | null;
  encrypted_webhook_secret: string | null;
  // postgres.js decodes TIMESTAMPTZ columns into JS `Date` objects, not strings (IN-02). The DTO
  // boundary (mapCredentialStatus -> vcsCredentialStatusSchema) normalizes these to ISO strings via
  // `dateStringSchema`, which accepts `string | Date`; annotate the raw row with the driver's real
  // return type so a future caller isn't misled into treating these as strings.
  token_expires_at: Date | null;
  label: string | null;
  created_at: Date;
  updated_at: Date;
};

export type VcsCredentialKey = {
  vcsProvider: 'github' | 'bitbucket';
  workspace: string;
  repoSlug: string;
};

// Internal-only secret view (mirrors mapProviderSecret in model-configs.ts). Exposes the ciphertext
// columns for decrypt/rotate paths ONLY. NEVER route this into an HTTP response (D-10 / T-04-01, T-04-05).
export type VcsCredentialSecret = VcsCredentialStatus & {
  encryptedAccessToken: string | null;
  encryptedWebhookSecret: string | null;
};

// Four-state status computed purely from token presence + expiry (D-05 / D-13). No live Bitbucket
// call -- pure date math, so it is deterministic and unit-testable. Exported for direct unit coverage.
//  - `missing`       : no token stored (regardless of any recorded expiry)
//  - `expired`       : token stored but tokenExpiresAt is in the past
//  - `expiring-soon` : token stored, expiry within EXPIRING_SOON_THRESHOLD_MS (boundary inclusive)
//  - `valid`         : token stored, expiry beyond the threshold, or no expiry recorded
export function computeCredentialStatus(
  { hasToken, tokenExpiresAt }: { hasToken: boolean; tokenExpiresAt: Date | string | null },
  now: Date = new Date(),
): CredentialStatus {
  if (!hasToken) return 'missing';
  if (tokenExpiresAt === null) return 'valid';

  const expiresMs =
    tokenExpiresAt instanceof Date ? tokenExpiresAt.getTime() : new Date(tokenExpiresAt).getTime();
  // Fail CLOSED on an undecodable expiry (WR-01): a NaN timestamp means we cannot prove the token
  // is still healthy, so treat it as `expired` rather than silently returning `valid`. Unreachable
  // via the current Zod-validated write path, but this fn is exported for reuse (Phase 5 webhook),
  // so a future caller could feed it a raw/unparseable value.
  if (Number.isNaN(expiresMs)) return 'expired';
  const deltaMs = expiresMs - now.getTime();

  if (deltaMs < 0) return 'expired';
  if (deltaMs <= EXPIRING_SOON_THRESHOLD_MS) return 'expiring-soon';
  return 'valid';
}

// Redacted read mapper (mirrors mapProvider's `hasApiKey: Boolean(row.encrypted_api_key)` in
// model-configs.ts): returns presence booleans + computed status + expiry/label, NEVER ciphertext or
// plaintext (D-10 / T-04-01). The Zod parse enforces the redacted contract shape at the boundary.
function mapCredentialStatus(row: VcsCredentialRow): VcsCredentialStatus {
  const hasToken = Boolean(row.encrypted_access_token);
  return vcsCredentialStatusSchema.parse({
    vcsProvider: row.vcs_provider,
    workspace: row.workspace,
    repoSlug: row.repo_slug,
    hasToken,
    hasWebhookSecret: Boolean(row.encrypted_webhook_secret),
    tokenExpiresAt: row.token_expires_at,
    label: row.label,
    status: computeCredentialStatus({ hasToken, tokenExpiresAt: row.token_expires_at }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

const CREDENTIAL_COLUMNS = `
  vcs_provider,
  workspace,
  repo_slug,
  encrypted_access_token,
  encrypted_webhook_secret,
  token_expires_at,
  label,
  created_at,
  updated_at
`;

export async function listVcsCredentials(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
): Promise<VcsCredentialStatus[]> {
  const rows = await queryRows<VcsCredentialRow>(
    env,
    `SELECT ${CREDENTIAL_COLUMNS}
     FROM vcs_credentials
     ORDER BY workspace ASC, repo_slug ASC`,
  );
  return rows.map(mapCredentialStatus);
}

// INTERNAL-ONLY: returns the ciphertext columns for decrypt/rotate use (mirror mapProviderSecret).
// Never serialize the result into an HTTP response (D-10 / T-04-01, T-04-05). All lookups are
// parameterized -- workspace/repo_slug are never string-interpolated (T-04-07).
export async function getVcsCredentialSecrets(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  key: VcsCredentialKey,
): Promise<VcsCredentialSecret | null> {
  const [row] = await queryRows<VcsCredentialRow>(
    env,
    `SELECT ${CREDENTIAL_COLUMNS}
     FROM vcs_credentials
     WHERE vcs_provider = $1 AND workspace = $2 AND repo_slug = $3`,
    [key.vcsProvider, key.workspace, key.repoSlug],
  );
  if (!row) return null;
  return {
    ...mapCredentialStatus(row),
    encryptedAccessToken: row.encrypted_access_token,
    encryptedWebhookSecret: row.encrypted_webhook_secret,
  };
}

export type UpsertVcsCredentialInput = VcsCredentialKey & {
  // string = set, null = clear, undefined = leave the stored value untouched (D-11).
  encryptedAccessToken?: string | null;
  encryptedWebhookSecret?: string | null;
  tokenExpiresAt?: string | null;
  label?: string | null;
};

// Rotate-in-place upsert on the UNIQUE(vcs_provider, workspace, repo_slug) key (D-11).
// CRITICAL (review finding 1): a naive `ON CONFLICT DO UPDATE SET token_expires_at =
// EXCLUDED.token_expires_at, label = EXCLUDED.label` WIPES the stored expiry/label whenever a
// rotation omits them (they default to NULL in the INSERT, so EXCLUDED is NULL). Instead the
// `DO UPDATE SET` list is built dynamically -- a column is appended ONLY when its input is not
// `undefined` -- applying the SAME conditional-append pattern to token_expires_at/label as to the
// two encrypted columns (mirrors updateLlmProvider in model-configs.ts:149-184). Only
// `updated_at = now()` is unconditional. On conflict, any omitted column keeps its stored value.
export async function upsertVcsCredential(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  input: UpsertVcsCredentialInput,
): Promise<VcsCredentialStatus> {
  const params: unknown[] = [input.vcsProvider, input.workspace, input.repoSlug];
  const insertColumns = ['vcs_provider', 'workspace', 'repo_slug'];
  const insertValues = ['$1', '$2', '$3'];
  const updates = ['updated_at = now()'];

  const optional: Array<[column: string, value: string | null | undefined]> = [
    ['encrypted_access_token', input.encryptedAccessToken],
    ['encrypted_webhook_secret', input.encryptedWebhookSecret],
    ['token_expires_at', input.tokenExpiresAt],
    ['label', input.label],
  ];

  for (const [column, value] of optional) {
    if (value === undefined) continue; // omitted -> leave the stored value untouched (D-11)
    params.push(value);
    const placeholder = `$${params.length}`;
    insertColumns.push(column);
    insertValues.push(placeholder);
    updates.push(`${column} = ${placeholder}`);
  }

  const [row] = await queryRows<VcsCredentialRow>(
    env,
    `
    INSERT INTO vcs_credentials (${insertColumns.join(', ')}, updated_at)
    VALUES (${insertValues.join(', ')}, now())
    ON CONFLICT (vcs_provider, workspace, repo_slug)
    DO UPDATE SET ${updates.join(', ')}
    RETURNING ${CREDENTIAL_COLUMNS}
    `,
    params,
  );
  return mapCredentialStatus(row);
}

export async function deleteVcsCredential(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  key: VcsCredentialKey,
): Promise<boolean> {
  const rows = await queryRows<{ workspace: string }>(
    env,
    `DELETE FROM vcs_credentials
     WHERE vcs_provider = $1 AND workspace = $2 AND repo_slug = $3
     RETURNING workspace`,
    [key.vcsProvider, key.workspace, key.repoSlug],
  );
  return rows.length > 0;
}
