import { describe, it, expect } from 'vitest';
import { encryptSecret, decryptSecret } from '@server/core/crypto';

// Group D-1 / KDF v2: new writes use a PBKDF2-derived, per-secret-salted AES-GCM key and
// emit the `v2:salt:iv:ciphertext` envelope, while pre-existing `v1:iv:ciphertext` rows
// (single unsalted SHA-256 derivation, already stored in production) MUST still decrypt
// unchanged — no data migration. This suite is DB-free by design: encryptSecret/decryptSecret
// only touch `LLM_CONFIG_ENCRYPTION_KEY`, so a minimal env avoids the full createTestEnv
// (which eagerly requires TEST_DATABASE_URL + provider env vars).
describe('core/crypto — v2 envelope (backward compatible)', () => {
  const env = { LLM_CONFIG_ENCRYPTION_KEY: 'test-llm-config-encryption-key' };
  const SECRET = 'ATBBxxxxxxxxxxxxxxxxxxxx-bitbucket-access-token';

  const encoder = new TextEncoder();
  const toB64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

  // Reproduces the legacy v1 derivation (unsalted SHA-256 → AES-GCM) exactly as it existed
  // before this change, so we can prove production v1 ciphertexts still decrypt.
  async function encryptV1(passphrase: string, plaintext: string) {
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(passphrase));
    const key = await crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(plaintext));
    return `v1:${toB64(iv)}:${toB64(new Uint8Array(ciphertext))}`;
  }

  it('new encryptSecret output starts with "v2:" and has 4 base64 segments', async () => {
    const encrypted = await encryptSecret(env, SECRET);
    const segments = encrypted.split(':');
    expect(segments).toHaveLength(4);
    expect(segments[0]).toBe('v2');
    expect(segments[1].length).toBeGreaterThan(0); // base64 salt
    expect(segments[2].length).toBeGreaterThan(0); // base64 IV
    expect(segments[3].length).toBeGreaterThan(0); // base64 ciphertext
  });

  it('round-trips a v2 secret: decryptSecret(encryptSecret(s)) === s', async () => {
    const encrypted = await encryptSecret(env, SECRET);
    expect(await decryptSecret(env, encrypted)).toBe(SECRET);
  });

  it('uses a random salt+IV: two encryptions of the same plaintext differ but both decrypt', async () => {
    const a = await encryptSecret(env, SECRET);
    const b = await encryptSecret(env, SECRET);
    expect(a).not.toBe(b);
    expect(await decryptSecret(env, a)).toBe(SECRET);
    expect(await decryptSecret(env, b)).toBe(SECRET);
  });

  // BACKWARD COMPAT (critical): a v1 ciphertext produced by the legacy unsalted-SHA-256
  // derivation must still decrypt to its plaintext via the current decryptSecret.
  it('still decrypts a legacy v1 ciphertext produced by the old SHA-256 derivation', async () => {
    const legacy = await encryptV1(env.LLM_CONFIG_ENCRYPTION_KEY, SECRET);
    expect(legacy.startsWith('v1:')).toBe(true);
    expect(await decryptSecret(env, legacy)).toBe(SECRET);
  });

  it('throws on a wrong key for a v2 ciphertext', async () => {
    const encrypted = await encryptSecret(env, SECRET);
    const wrongEnv = { LLM_CONFIG_ENCRYPTION_KEY: 'totally-different-encryption-key' };
    await expect(decryptSecret(wrongEnv, encrypted)).rejects.toThrow();
  });

  it('throws "Unsupported encrypted secret format." on a malformed / unknown-version envelope', async () => {
    await expect(decryptSecret(env, 'v3:aaaa:bbbb:cccc')).rejects.toThrow('Unsupported encrypted secret format.');
    await expect(decryptSecret(env, 'v2:only:three')).rejects.toThrow('Unsupported encrypted secret format.');
    await expect(decryptSecret(env, 'garbage')).rejects.toThrow('Unsupported encrypted secret format.');
  });

  it('throws an error containing "LLM_CONFIG_ENCRYPTION_KEY" when the key is too short', async () => {
    const badEnv = { LLM_CONFIG_ENCRYPTION_KEY: 'short' };
    await expect(encryptSecret(badEnv, SECRET)).rejects.toThrow('LLM_CONFIG_ENCRYPTION_KEY');
  });
});
