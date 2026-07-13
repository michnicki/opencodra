import { describe, it, expect } from 'vitest';
// RED (Wave 0): `@server/core/crypto` does not exist yet — it is extracted from
// `core/llm-crypto.ts` in Plan 02. This import is expected to fail to resolve at
// collection time; that missing-module signal IS the acceptance criterion for this
// plan (see 04-01-PLAN.md Task 1). Do NOT create the module here.
import { encryptSecret, decryptSecret } from '@server/core/crypto';
// NREG-02: the existing LLM wrappers must keep round-tripping AND share the exact
// same code path as the extracted core once Plan 02 lands.
import { encryptLlmApiKey, decryptLlmApiKey } from '@server/core/llm-crypto';
import { createTestEnv } from './helpers';

// AUTH-02 / D-08: generic secret encryption primitive, extracted from the LLM key
// helper so both LLM API keys and VCS bot credentials encrypt through one path.
describe('core/crypto encryptSecret/decryptSecret', () => {
  const env = createTestEnv();
  const SECRET = 'ATBBxxxxxxxxxxxxxxxxxxxx-bitbucket-access-token';

  it('round-trips a secret: decryptSecret(encryptSecret(s)) === s (AUTH-02 crit.1)', async () => {
    const encrypted = await encryptSecret(env, SECRET);
    expect(await decryptSecret(env, encrypted)).toBe(SECRET);
  });

  it('produces the versioned v1:iv:ciphertext shape (three colon-separated segments starting v1)', async () => {
    const encrypted = await encryptSecret(env, SECRET);
    const segments = encrypted.split(':');
    expect(segments).toHaveLength(3);
    expect(segments[0]).toBe('v1');
    expect(segments[1].length).toBeGreaterThan(0); // base64 IV
    expect(segments[2].length).toBeGreaterThan(0); // base64 ciphertext
  });

  it('uses a random IV: two encryptions of the same plaintext differ (mitigates T-04-06)', async () => {
    const a = await encryptSecret(env, SECRET);
    const b = await encryptSecret(env, SECRET);
    expect(a).not.toBe(b);
    // ...but both still decrypt back to the same original.
    expect(await decryptSecret(env, a)).toBe(SECRET);
    expect(await decryptSecret(env, b)).toBe(SECRET);
  });

  // NREG-02 / T-04-03: the LLM wrappers must remain functional AND interchangeable
  // with the extracted core (proving one shared code path per D-06/D-07).
  it('preserves LLM wrapper round-trip after extraction (NREG-02)', async () => {
    const apiKey = 'sk-test-llm-api-key-value';
    const encrypted = await encryptLlmApiKey(env, apiKey);
    expect(await decryptLlmApiKey(env, encrypted)).toBe(apiKey);
  });

  it('is cross-path interchangeable: encryptSecret decrypts via decryptLlmApiKey and vice-versa (NREG-02 / T-04-03)', async () => {
    const value = 'shared-code-path-secret';

    const viaCore = await encryptSecret(env, value);
    expect(await decryptLlmApiKey(env, viaCore)).toBe(value);

    const viaWrapper = await encryptLlmApiKey(env, value);
    expect(await decryptSecret(env, viaWrapper)).toBe(value);
  });

  // Pitfall 1 / review finding 4: routes/api/models.ts::isEncryptionConfigError keys off
  // the `LLM_CONFIG_ENCRYPTION_KEY` substring in the thrown error. Assert on the substring
  // ONLY — never paste the full 16-char guard sentence into an assertion.
  it('throws an error containing "LLM_CONFIG_ENCRYPTION_KEY" when the key is too short (NREG-02 / Pitfall 1)', async () => {
    const badEnv = createTestEnv({ LLM_CONFIG_ENCRYPTION_KEY: 'short' });

    let caught: unknown;
    try {
      await encryptSecret(badEnv, SECRET);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('LLM_CONFIG_ENCRYPTION_KEY');
  });
});
