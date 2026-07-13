import type { AppBindings } from '@server/env';

// Single source of truth for the encrypted-value version prefix (review finding 13a).
// The format is `v1:iv:ciphertext` — bumping this constant is the migration lever if
// the derivation/cipher ever changes; keep it here so both the LLM wrappers and any
// future secret consumer (VCS bot credentials) share one literal and cannot drift.
export const KEY_VERSION = 'v1';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64(bytes: Uint8Array) {
  return Buffer.from(bytes).toString('base64');
}

function fromBase64(value: string) {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

async function importEncryptionKey(secret: string) {
  if (!secret || secret.trim().length < 16) {
    // The `LLM_CONFIG_ENCRYPTION_KEY` substring is load-bearing:
    // routes/api/models.ts::isEncryptionConfigError matches on it to surface a
    // 400 config error instead of a 500. Do NOT change this wording (NREG-02 / Pitfall 1).
    throw new Error('LLM_CONFIG_ENCRYPTION_KEY must be at least 16 characters long.');
  }

  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(secret));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

// Generic AES-GCM secret encryption keyed by LLM_CONFIG_ENCRYPTION_KEY (D-06/D-07).
// Reuses the single existing encryption key — introduces NO new secret. Output is the
// versioned `v1:iv:ciphertext` shape with a fresh 12-byte random IV per call (D-08 / T-04-06).
export async function encryptSecret(
  env: Pick<AppBindings, 'LLM_CONFIG_ENCRYPTION_KEY'>,
  plaintext: string,
) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importEncryptionKey(env.LLM_CONFIG_ENCRYPTION_KEY);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(plaintext),
  );

  return `${KEY_VERSION}:${toBase64(iv)}:${toBase64(new Uint8Array(ciphertext))}`;
}

export async function decryptSecret(
  env: Pick<AppBindings, 'LLM_CONFIG_ENCRYPTION_KEY'>,
  encrypted: string,
) {
  const [version, ivBase64, ciphertextBase64] = encrypted.split(':');
  if (version !== KEY_VERSION || !ivBase64 || !ciphertextBase64) {
    throw new Error('Unsupported encrypted secret format.');
  }

  const key = await importEncryptionKey(env.LLM_CONFIG_ENCRYPTION_KEY);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(ivBase64) },
    key,
    fromBase64(ciphertextBase64),
  );

  return decoder.decode(plaintext);
}
