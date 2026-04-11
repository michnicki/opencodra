const encoder = new TextEncoder();

function hexToBytes(hex: string) {
  const clean = hex.trim().toLowerCase();
  const bytes = new Uint8Array(clean.length / 2);

  for (let index = 0; index < clean.length; index += 2) {
    bytes[index / 2] = Number.parseInt(clean.slice(index, index + 2), 16);
  }

  return bytes;
}

export async function verifyGitHubWebhookSignature(secret: string, headerValue: string | null, rawBody: string) {
  if (!headerValue?.startsWith('sha256=')) {
    return false;
  }

  const signature = headerValue.slice('sha256='.length);
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );

  return crypto.subtle.verify('HMAC', key, hexToBytes(signature), encoder.encode(rawBody));
}
