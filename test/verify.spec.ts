import { describe, expect, it } from 'vitest';
import {
  verifyGitHubWebhookSignature,
  verifyWebhookSignature,
} from '@server/core/verify';

const encoder = new TextEncoder();

async function signBody(secret: string, rawBody: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));
  const hex = Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `sha256=${hex}`;
}

describe('verifyWebhookSignature', () => {
  const secret = 'webhook-test-secret';
  const rawBody = JSON.stringify({ pullrequest: { id: 42 } });

  it('verifies a correctly signed Bitbucket raw body', async () => {
    const signature = await signBody(secret, rawBody);

    await expect(verifyWebhookSignature({
      secret,
      signatureHeaderName: 'x-hub-signature',
      signature,
      rawBody,
    })).resolves.toBe(true);
  });

  it('rejects a tampered Bitbucket raw body', async () => {
    const signature = await signBody(secret, rawBody);

    await expect(verifyWebhookSignature({
      secret,
      signatureHeaderName: 'x-hub-signature',
      signature,
      rawBody: `${rawBody} `,
    })).resolves.toBe(false);
  });

  it('rejects missing signatures and signatures without the sha256 prefix', async () => {
    const signature = await signBody(secret, rawBody);
    const bareSignature = signature.slice('sha256='.length);

    await expect(verifyWebhookSignature({
      secret,
      signatureHeaderName: 'x-hub-signature',
      signature: bareSignature,
      rawBody,
    })).resolves.toBe(false);
    await expect(verifyWebhookSignature({
      secret,
      signatureHeaderName: 'x-hub-signature',
      signature: null,
      rawBody,
    })).resolves.toBe(false);
    await expect(verifyWebhookSignature({
      secret,
      signatureHeaderName: 'x-hub-signature',
      signature: undefined,
      rawBody,
    })).resolves.toBe(false);
  });

  it('keeps the GitHub shim byte-identical to the generalized path', async () => {
    const correctSignature = await signBody(secret, rawBody);
    const cases: Array<{ signature: string | null; body: string }> = [
      { signature: correctSignature, body: rawBody },
      { signature: correctSignature, body: `${rawBody} ` },
      { signature: correctSignature.slice('sha256='.length), body: rawBody },
      { signature: null, body: rawBody },
    ];

    for (const input of cases) {
      const generalized = await verifyWebhookSignature({
        secret,
        signatureHeaderName: 'x-hub-signature-256',
        signature: input.signature,
        rawBody: input.body,
      });
      const legacy = await verifyGitHubWebhookSignature(secret, input.signature, input.body);

      expect(legacy).toBe(generalized);
    }
  });
});
