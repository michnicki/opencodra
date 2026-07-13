import type { AppBindings } from '@server/env';
import { encryptSecret, decryptSecret } from './crypto';

// The AES-GCM primitive was extracted to `core/crypto.ts` (D-06/D-07/D-08) so LLM API
// keys and VCS bot credentials encrypt through one shared code path. These wrappers keep
// the exact `(env, value)` signatures every existing importer (e.g. routes/api/models.ts)
// relies on, delegating verbatim to the generic primitive (NREG-02 — byte-identical behavior).
export function encryptLlmApiKey(env: Pick<AppBindings, 'LLM_CONFIG_ENCRYPTION_KEY'>, apiKey: string) {
  return encryptSecret(env, apiKey);
}

export function decryptLlmApiKey(env: Pick<AppBindings, 'LLM_CONFIG_ENCRYPTION_KEY'>, encrypted: string) {
  return decryptSecret(env, encrypted);
}
