import { verifyGitHubWebhookSignature } from '@server/core/verify';

describe('verifyGitHubWebhookSignature', () => {
  it('accepts a valid sha256 signature', async () => {
    const secret = 'super-secret';
    const body = JSON.stringify({ ok: true });
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
    const hex = Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('');

    await expect(verifyGitHubWebhookSignature(secret, `sha256=${hex}`, body)).resolves.toBe(true);
  });

  it('rejects an invalid signature', async () => {
    await expect(verifyGitHubWebhookSignature('secret', 'sha256=deadbeef', '{"ok":true}')).resolves.toBe(false);
  });
});
