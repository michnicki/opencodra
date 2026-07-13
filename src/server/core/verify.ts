// D-05: GitHub and Bitbucket both sign the exact raw webhook body with HMAC-SHA256,
// differing only in the HTTP header that carries the signature. Keep the primitive shared while
// preserving verifyGitHubWebhookSignature's public call shape so the existing route is unchanged.
const encoder = new TextEncoder();
const SHA256_PREFIX = 'sha256=';

type WebhookSignatureHeaderName = 'x-hub-signature' | 'x-hub-signature-256';

function hexToBytes(hex: string) {
  const clean = hex.trim().toLowerCase();
  if (clean.length === 0 || clean.length % 2 !== 0 || !/^[0-9a-f]+$/.test(clean)) {
    return null;
  }

  const bytes = new Uint8Array(clean.length / 2);
  for (let index = 0; index < clean.length; index += 2) {
    bytes[index / 2] = Number.parseInt(clean.slice(index, index + 2), 16);
  }

  return bytes;
}

export async function verifyWebhookSignature(input: {
  secret: string;
  signatureHeaderName: WebhookSignatureHeaderName;
  signature?: string | null;
  rawBody: string;
}) {
  if (!input.signature?.startsWith(SHA256_PREFIX)) {
    return false;
  }

  // The name documents which route supplied the value. Both currently use the same sha256 prefix
  // and algorithm, but retaining it at the seam prevents callers from silently conflating headers.
  void input.signatureHeaderName;
  const signature = hexToBytes(input.signature.slice(SHA256_PREFIX.length));
  if (!signature) {
    return false;
  }

  try {
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(input.secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );

    return crypto.subtle.verify('HMAC', key, signature, encoder.encode(input.rawBody));
  } catch {
    // Malformed signatures are untrusted input and must fail closed rather than crash the Worker.
    return false;
  }
}

export async function verifyGitHubWebhookSignature(secret: string, headerValue: string | null, rawBody: string) {
  return verifyWebhookSignature({
    secret,
    signatureHeaderName: 'x-hub-signature-256',
    signature: headerValue,
    rawBody,
  });
}
