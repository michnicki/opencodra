/**
 * Shared SSRF guard for user-configurable provider base URLs.
 *
 * Rejects URLs whose host is a literal private, loopback, link-local,
 * unique-local, or cloud-metadata target. Covers dotted-decimal IPv4, non-dotted
 * IPv4 (pure decimal, hex `0x...`, and leading-zero octal), IPv6 (loopback,
 * unspecified, ULA `fc00::/7`, link-local `fe80::/10`, and IPv4-mapped
 * `::ffff:a.b.c.d`), plus known metadata hostnames.
 *
 * NOTE: DNS rebinding is NOT mitigated here. Cloudflare Workers cannot resolve a
 * hostname and pin the resolved address before `fetch`, so an attacker-controlled
 * DNS name that resolves to a private IP at fetch time can still slip through.
 * This guard blocks only *literal* private/reserved targets supplied directly in
 * the URL — it is a defense-in-depth control, not a complete SSRF fix.
 */

// Cloud metadata endpoints that are routable public-looking hosts but expose
// instance credentials. `169.254.169.254` (AWS/GCP/Azure) is already covered by
// the 169.254/16 link-local check; these are the ones that need explicit listing.
const METADATA_HOSTNAMES = new Set([
  'metadata.google.internal',
  '100.100.100.200', // Alibaba Cloud metadata service
]);

/** Parse a single IPv4 part supporting decimal, hex (`0x..`), and octal (`0..`) forms. */
function parseIPv4Part(part: string): number | null {
  if (part === '') return null;
  let value: number;
  if (/^0x[0-9a-f]+$/i.test(part)) {
    value = parseInt(part.slice(2), 16);
  } else if (/^0[0-7]+$/.test(part)) {
    value = parseInt(part, 8);
  } else if (/^(0|[1-9][0-9]*)$/.test(part)) {
    value = parseInt(part, 10);
  } else {
    return null;
  }
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Parse an all-numeric IPv4 host into a canonical dotted quad `[a, b, c, d]`.
 * Handles the compressed inet_aton forms (`a`, `a.b`, `a.b.c`, `a.b.c.d`) and
 * non-decimal parts. Returns null for anything that isn't a pure IPv4 literal
 * (e.g. a domain name), so callers fall through to hostname-string checks.
 */
function parseIPv4Host(hostname: string): [number, number, number, number] | null {
  const rawParts = hostname.split('.');
  if (rawParts.length < 1 || rawParts.length > 4) return null;

  const nums: number[] = [];
  for (const part of rawParts) {
    const n = parseIPv4Part(part);
    if (n === null) return null;
    nums.push(n);
  }

  let value: number;
  switch (nums.length) {
    case 1:
      value = nums[0];
      break;
    case 2:
      if (nums[0] > 0xff || nums[1] > 0xffffff) return null;
      value = nums[0] * 0x1000000 + nums[1];
      break;
    case 3:
      if (nums[0] > 0xff || nums[1] > 0xff || nums[2] > 0xffff) return null;
      value = nums[0] * 0x1000000 + nums[1] * 0x10000 + nums[2];
      break;
    default:
      if (nums.some((x) => x > 0xff)) return null;
      value = nums[0] * 0x1000000 + nums[1] * 0x10000 + nums[2] * 0x100 + nums[3];
      break;
  }

  if (value < 0 || value > 0xffffffff) return null;
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ];
}

function isPrivateIPv4([a, b]: [number, number, number, number]): boolean {
  if (a === 0) return true; // 0.0.0.0/8 ("this host") incl. 0.0.0.0
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (incl. 169.254.169.254 metadata)
  return false;
}

/**
 * Extract an embedded IPv4 address from an IPv4-mapped IPv6 host. Handles both the
 * dotted form `::ffff:a.b.c.d` and the compressed hex form `::ffff:wxyz:wxyz` that
 * the WHATWG URL parser normalizes such addresses to.
 */
function extractMappedIPv4(host: string): string | null {
  const dotted = host.match(/:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) return dotted[1];

  const hex = host.match(/::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
  }
  return null;
}

function isPrivateIPv6(host: string): boolean {
  if (host === '::1') return true; // loopback
  if (host === '::') return true; // unspecified

  const mapped = extractMappedIPv4(host);
  if (mapped) {
    const parts = parseIPv4Host(mapped);
    if (parts && isPrivateIPv4(parts)) return true;
  }

  if (/^f[cd]/.test(host)) return true; // ULA fc00::/7 (first byte 0xfc or 0xfd)
  if (/^fe[89ab]/.test(host)) return true; // link-local fe80::/10
  return false;
}

/**
 * True when `hostname` names a private, loopback, link-local, unique-local, or
 * cloud-metadata target. Accepts bracketed (`[::1]`) or bare IPv6, dotted or
 * non-dotted IPv4, and hostnames.
 */
export function isPrivateOrReservedHost(hostname: string): boolean {
  const host = hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();

  if (host === 'localhost') return true;
  if (METADATA_HOSTNAMES.has(host)) return true;

  if (host.includes(':')) {
    return isPrivateIPv6(host);
  }

  const ipv4 = parseIPv4Host(host);
  if (ipv4) return isPrivateIPv4(ipv4);

  return false;
}

/**
 * True when `urlString` is a well-formed http(s) URL whose host is not a private
 * or reserved target. Use before issuing `fetch` to a user-configured base URL.
 */
export function isValidPublicUrl(urlString: string): boolean {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return !isPrivateOrReservedHost(url.hostname);
}
