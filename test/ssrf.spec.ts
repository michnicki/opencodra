import { describe, expect, it } from 'vitest';
import { isValidPublicUrl, isPrivateOrReservedHost } from '@server/core/ssrf';

describe('isValidPublicUrl', () => {
  const blocked = [
    'http://127.0.0.1',
    'http://2130706433', // decimal 127.0.0.1
    'http://0x7f000001', // hex 127.0.0.1
    'http://0177.0.0.1', // octal-first-octet 127.0.0.1
    'http://[::1]',
    'http://[::]',
    'http://[::ffff:169.254.169.254]', // IPv4-mapped link-local metadata
    'http://[fd00::1]', // ULA fc00::/7
    'http://[fe80::1]', // link-local fe80::/10
    'http://169.254.169.254', // cloud metadata
    'http://metadata.google.internal',
    'http://100.100.100.200', // Alibaba metadata
    'http://localhost',
    'ftp://example.com', // non-http protocol
    'file:///etc/passwd', // non-http protocol
    '', // unparseable
  ];

  it.each(blocked)('blocks %s', (url) => {
    expect(isValidPublicUrl(url)).toBe(false);
  });

  const allowed = [
    'https://api.openai.com',
    'https://generativelanguage.googleapis.com/v1beta',
    'http://example.com:8080/v1',
  ];

  it.each(allowed)('allows %s', (url) => {
    expect(isValidPublicUrl(url)).toBe(true);
  });
});

describe('isPrivateOrReservedHost', () => {
  it('strips IPv6 brackets before evaluating', () => {
    expect(isPrivateOrReservedHost('[::1]')).toBe(true);
    expect(isPrivateOrReservedHost('::1')).toBe(true);
  });

  it('treats public hostnames as non-reserved', () => {
    expect(isPrivateOrReservedHost('api.openai.com')).toBe(false);
    expect(isPrivateOrReservedHost('8.8.8.8')).toBe(false);
  });

  it('covers the RFC1918 private ranges', () => {
    expect(isPrivateOrReservedHost('10.1.2.3')).toBe(true);
    expect(isPrivateOrReservedHost('172.16.0.1')).toBe(true);
    expect(isPrivateOrReservedHost('172.31.255.255')).toBe(true);
    expect(isPrivateOrReservedHost('192.168.1.1')).toBe(true);
    expect(isPrivateOrReservedHost('172.32.0.1')).toBe(false); // just outside 172.16/12
  });
});
