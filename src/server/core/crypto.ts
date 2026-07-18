import type { AppBindings } from '@server/env';

// Single source of truth for the encrypted-value version prefix (review finding 13a).
// `KEY_VERSION` is the version stamped onto every NEW ciphertext and is the migration
// lever if the derivation/cipher changes again. It is currently `v2`: a PBKDF2-derived
// AES-GCM key with a per-secret random salt, format `v2:salt:iv:ciphertext` (base64).
// `KEY_VERSION_V1` is the legacy envelope — a single unsalted SHA-256 of the passphrase,
// format `v1:iv:ciphertext`. v1 rows are still readable (decrypt-only, no re-derivation)
// so already-stored production secrets keep working with NO data migration; every new
// write is v2. Both live here so the LLM wrappers and any future secret consumer
// (VCS bot credentials) share one literal and cannot drift.
export const KEY_VERSION = 'v2';
export const KEY_VERSION_V1 = 'v1';

// PBKDF2 work factor for the v2 envelope. 100k SHA-256 iterations balances brute-force
// resistance against the per-request derivation cost inside a Workers isolate.
const PBKDF2_ITERATIONS = 100_000;
// 16-byte random salt per secret so identical plaintexts under the same passphrase never
// derive the same AES key; 12-byte IV is the AES-GCM standard nonce length.
const SALT_BYTES = 16;
const IV_BYTES = 12;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64(bytes: Uint8Array) {
  return Buffer.from(bytes).toString('base64');
}

function fromBase64(value: string) {
  const buf = Buffer.from(value, 'base64');
  // Copy into a freshly-allocated ArrayBuffer so the result is a Uint8Array<ArrayBuffer>
  // (not the shared Node Buffer pool / ArrayBufferLike), which Web Crypto's BufferSource
  // params (PBKDF2 salt, AES-GCM iv) require under strict typing.
  return new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

function assertEncryptionKey(secret: string) {
  if (!secret || secret.trim().length < 16) {
    // The `LLM_CONFIG_ENCRYPTION_KEY` substring is load-bearing:
    // routes/api/models.ts::isEncryptionConfigError matches on it to surface a
    // 400 config error instead of a 500. Do NOT change this wording (NREG-02 / Pitfall 1).
    throw new Error('LLM_CONFIG_ENCRYPTION_KEY must be at least 16 characters long.');
  }
}

// Legacy v1 key: a single unsalted SHA-256 of the passphrase imported as an AES-GCM key.
// Used ONLY on the decrypt path for pre-existing `v1:` ciphertexts; never for new writes.
async function importEncryptionKey(secret: string) {
  assertEncryptionKey(secret);

  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(secret));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

// v2 key: derive an AES-GCM key from the passphrase via PBKDF2 with a per-secret salt.
async function deriveKeyV2(secret: string, salt: BufferSource) {
  assertEncryptionKey(secret);

  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    'PBKDF2',
    false,
    ['deriveKey'],
  );

  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// Generic AES-GCM secret encryption keyed by LLM_CONFIG_ENCRYPTION_KEY (D-06/D-07).
// Reuses the single existing encryption key — introduces NO new secret. Output is the
// versioned `v2:salt:iv:ciphertext` shape with a fresh 16-byte salt and 12-byte random
// IV per call (D-08 / T-04-06).
export async function encryptSecret(
  env: Pick<AppBindings, 'LLM_CONFIG_ENCRYPTION_KEY'>,
  plaintext: string,
) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKeyV2(env.LLM_CONFIG_ENCRYPTION_KEY, salt);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(plaintext),
  );

  return `${KEY_VERSION}:${toBase64(salt)}:${toBase64(iv)}:${toBase64(new Uint8Array(ciphertext))}`;
}

export async function decryptSecret(
  env: Pick<AppBindings, 'LLM_CONFIG_ENCRYPTION_KEY'>,
  encrypted: string,
) {
  const segments = encrypted.split(':');
  const version = segments[0];

  // Legacy path: pre-existing `v1:iv:ciphertext` rows keep decrypting unchanged.
  if (version === KEY_VERSION_V1) {
    const [, ivBase64, ciphertextBase64] = segments;
    if (segments.length !== 3 || !ivBase64 || !ciphertextBase64) {
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

  // Current path: `v2:salt:iv:ciphertext` via PBKDF2-derived key.
  if (version === KEY_VERSION) {
    const [, saltBase64, ivBase64, ciphertextBase64] = segments;
    if (segments.length !== 4 || !saltBase64 || !ivBase64 || !ciphertextBase64) {
      throw new Error('Unsupported encrypted secret format.');
    }

    const key = await deriveKeyV2(env.LLM_CONFIG_ENCRYPTION_KEY, fromBase64(saltBase64));
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(ivBase64) },
      key,
      fromBase64(ciphertextBase64),
    );

    return decoder.decode(plaintext);
  }

  throw new Error('Unsupported encrypted secret format.');
}
