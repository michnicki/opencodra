import { Hono } from 'hono';
import type { AppEnv } from '@server/env';
import { jsonError } from '@server/core/http';
import { encryptSecret } from '@server/core/crypto';
import {
  deleteVcsCredential,
  getVcsCredentialSecrets,
  listVcsCredentials,
  upsertVcsCredential,
} from '@server/db/vcs-credentials';
import { vcsCredentialStoreSchema } from '@shared/schema';

// Encrypt-at-boundary helper (mirrors encryptedApiKeyFromBody in routes/api/models.ts:75-81).
// Load-bearing clear-vs-omit distinction (D-11 / review finding 3):
//   - clear === true          -> null       (clear the stored column)
//   - secret === undefined     -> undefined  (omitted -> leave the stored value untouched)
//   - secret.trim() === ''     -> undefined  (blank -> leave the stored value untouched)
//   - otherwise                -> encryptSecret(env, secret.trim())  (set new ciphertext)
async function encryptedSecretFromBody(
  env: AppEnv['Bindings'],
  secret?: string,
  clear?: boolean,
): Promise<string | null | undefined> {
  if (clear) return null;
  if (secret === undefined) return undefined;
  const trimmed = secret.trim();
  if (!trimmed) return undefined;
  return encryptSecret(env, trimmed);
}

// Copied verbatim from routes/api/models.ts:83-85 (Pitfall 1). The `LLM_CONFIG_ENCRYPTION_KEY`
// substring is matched to surface a 400 config error rather than a 500.
function isEncryptionConfigError(error: unknown) {
  return error instanceof Error && error.message.includes('LLM_CONFIG_ENCRYPTION_KEY');
}

export function createVcsCredentialsRouter() {
  const app = new Hono<AppEnv>();

  // GET / -> redacted list-status DTOs only, never ciphertext (D-10 / T-04-01).
  app.get('/', async (c) => {
    return c.json({ credentials: await listVcsCredentials(c.env) });
  });

  // POST / -> store/rotate upsert with encrypt-at-boundary (D-11).
  app.post('/', async (c) => {
    const parsed = vcsCredentialStoreSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      // The strict bitbucket-literal provider, lowercase-normalized identity, and strict ISO
      // expiry are enforced here — a malformed tokenExpiresAt is rejected before any DB write
      // (review finding 5).
      return jsonError('Invalid credential.', 400);
    }

    const input = parsed.data;

    let encryptedAccessToken: string | null | undefined;
    let encryptedWebhookSecret: string | null | undefined;
    try {
      encryptedAccessToken = await encryptedSecretFromBody(c.env, input.accessToken, input.clearToken);
      encryptedWebhookSecret = await encryptedSecretFromBody(
        c.env,
        input.webhookSecret,
        input.clearWebhookSecret,
      );
    } catch (error) {
      if (isEncryptionConfigError(error)) {
        return jsonError(error instanceof Error ? error.message : 'Encryption is not configured.', 400);
      }
      throw error;
    }

    const key = {
      vcsProvider: input.vcsProvider,
      workspace: input.workspace,
      repoSlug: input.repoSlug,
    };

    // CREATE-VS-ROTATE GATE (review finding 2): a brand-new credential requires BOTH secrets to
    // resolve to a set ciphertext. A `string` is a set value; `null` (clear) and `undefined`
    // (omitted/blank) are not. The existence check reads secrets internally only — its result is
    // NEVER serialized into the response (D-10 / T-04-01).
    const existing = await getVcsCredentialSecrets(c.env, key);
    if (!existing && (typeof encryptedAccessToken !== 'string' || typeof encryptedWebhookSecret !== 'string')) {
      return jsonError('A new credential requires both an access token and a webhook secret.', 400);
    }

    const credential = await upsertVcsCredential(c.env, {
      ...key,
      encryptedAccessToken,
      encryptedWebhookSecret,
      tokenExpiresAt: input.tokenExpiresAt,
      label: input.label,
    });

    return c.json({ credential }, 200);
  });

  // DELETE /:vcsProvider/:workspace/:repoSlug — params are read via Hono's single decode (no manual
  // decodeURIComponent, review finding 12); provider validated as bitbucket before any DB call
  // (finding 6); identity lowercased to match the lowercase-normalized stored key (finding 11).
  app.delete('/:vcsProvider/:workspace/:repoSlug', async (c) => {
    const vcsProvider = c.req.param('vcsProvider');
    if (vcsProvider !== 'bitbucket') {
      return jsonError('Unsupported provider.', 400);
    }

    const workspace = c.req.param('workspace').toLowerCase();
    const repoSlug = c.req.param('repoSlug').toLowerCase();

    const deleted = await deleteVcsCredential(c.env, { vcsProvider: 'bitbucket', workspace, repoSlug });
    if (!deleted) {
      return jsonError('Credential not found.', 404);
    }
    return c.json({ ok: true });
  });

  return app;
}
