import { describe, it, expect, vi, afterEach } from 'vitest';

// RED (Wave 0): `parseAllowedUsersByProvider` does not exist yet on `@server/core/oauth` — Wave 1
// (06-02-PLAN.md) replaces the legacy `parseAllowedUsers` with this provider-keyed parser (D-27).
// This import is expected to fail to resolve at collection time; that missing-module-export
// signal IS the acceptance criterion for this plan. Do NOT create the parser here, and do NOT
// import the legacy `parseAllowedUsers` (mirrors the Phase 4 Wave 0 import-based RED precedent).
import { parseAllowedUsersByProvider } from '@server/core/oauth';
import { logger } from '@server/core/logger';

describe('parseAllowedUsersByProvider — D-27/D-28 + Pitfall 1', () => {
  // Restores the logger.error spy from case (6) so it never leaks into later cases
  // (06-REVIEWS.md LOW finding).
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses a JSON object keyed by provider, preserving Bitbucket account_id byte-identically', () => {
    const result = parseAllowedUsersByProvider(
      '{"github":["devarshishimpi"],"bitbucket":["557058:1bb1b1aa-aaaa-bbbb-cccc-ddddeeeeffff"]}',
    );

    expect(result.github.has('devarshishimpi')).toBe(true);
    expect(result.bitbucket.has('557058:1bb1b1aa-aaaa-bbbb-cccc-ddddeeeeffff')).toBe(true);
  });

  it('lowercases a mixed-case GitHub login (D-27)', () => {
    const result = parseAllowedUsersByProvider('{"github":["DEVArshiShimpi"]}');
    expect(result.github.has('devarshishimpi')).toBe(true);
    expect(result.github.has('DEVArshiShimpi')).toBe(false);
  });

  it('preserves a mixed-case Bitbucket account_id byte-identically — NO lowercase (Pitfall 1)', () => {
    const result = parseAllowedUsersByProvider(
      '{"bitbucket":["557058:1BB1B1AA-aaaa-bbbb-cccc-ddddeeeeffff"]}',
    );
    expect(result.bitbucket.has('557058:1BB1B1AA-aaaa-bbbb-cccc-ddddeeeeffff')).toBe(true);
  });

  it('trims surrounding whitespace on the input string and parses cleanly', () => {
    const result = parseAllowedUsersByProvider('  {"github":["devarshishimpi"]}  ');
    expect(result.github.has('devarshishimpi')).toBe(true);
  });

  it('throws with a message containing "JSON must parse to an object" on malformed JSON', () => {
    let caught: unknown;
    try {
      parseAllowedUsersByProvider('{not-an-object');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('JSON must parse to an object');
  });

  it('accepts the legacy comma-separated GitHub-only format and logs an error once (D-27 migration)', () => {
    // Escalated from warn to error in src: the legacy CSV format silently DISABLES all Bitbucket
    // allowlisting, so the diagnostic is now logged at error level to make a misconfigured
    // deployment loud. logger.error's signature is `error(message: string, error?: unknown)`.
    const errorSpy = vi.spyOn(logger, 'error');

    const result = parseAllowedUsersByProvider('devarshishimpi');

    expect(result.github.has('devarshishimpi')).toBe(true);
    expect(result.bitbucket.size).toBe(0);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('legacy comma-separated format'));
  });

  it('returns empty sets for both providers on an empty string, without throwing', () => {
    const result = parseAllowedUsersByProvider('');
    expect(result.github.size).toBe(0);
    expect(result.bitbucket.size).toBe(0);
  });
});
