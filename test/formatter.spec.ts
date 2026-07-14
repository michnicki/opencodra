import { describe, it, expect } from 'vitest';
import { FormatterService } from '@server/services/formatter';
import type { ParsedReviewComment } from '@shared/schema';

const BASE_URL = 'https://app.codra.example.com';
const formatter = new FormatterService(BASE_URL);

function comment(overrides: Partial<ParsedReviewComment> = {}): ParsedReviewComment {
  return {
    path: 'src/index.ts',
    line: 10,
    position: 3,
    severity: 'P1',
    category: 'quality',
    title: 'Example finding',
    body: 'Something worth looking at.',
    codeSuggestion: null,
    ...overrides,
  };
}

describe('FormatterService.severityIcon', () => {
  it.each(['P0', 'P1', 'P2', 'P3', 'nit'] as const)('renders an <img> icon for %s', (severity) => {
    const icon = formatter.severityIcon(severity);
    expect(icon).toContain(`<img src="${BASE_URL}/icons/${severity.toLowerCase()}-icon.svg"`);
    expect(icon).toContain(`alt="${severity}"`);
  });

  it('falls back to a plain circle for unknown severities', () => {
    expect(formatter.severityIcon('unknown' as ParsedReviewComment['severity'])).toBe('⚪');
  });

  // D-13 (REV-R-01 widening): the Bitbucket provider path uses emoji instead of <img>. The GitHub
  // path is unchanged — passing provider='github' (or no options at all) returns the <img> shape.
  it.each([
    ['P0', '🚨 P0'],
    ['P1', '⚠️ P1'],
    ['P2', '⚠️ P2'],
    ['P3', 'ℹ️ P3'],
    ['nit', '💬 nit'],
  ] as const)('returns emoji for %s when provider is "bitbucket"', (severity, expected) => {
    expect(formatter.severityIcon(severity, { provider: 'bitbucket' })).toBe(expected);
  });

  it('returns the <img> shape for "github" provider (byte-identical to no-options path)', () => {
    const icon = formatter.severityIcon('P1', { provider: 'github' });
    expect(icon).toContain(`<img src="${BASE_URL}/icons/p1-icon.svg"`);
    expect(icon).toContain('alt="P1"');
  });

  it('falls back to a plain circle for unknown severities when provider is "bitbucket"', () => {
    expect(formatter.severityIcon('unknown' as ParsedReviewComment['severity'], { provider: 'bitbucket' })).toBe('⚪');
  });
});

describe('FormatterService.stripLeadingTags', () => {
  it('strips a leading emoji', () => {
    expect(formatter.stripLeadingTags('🔒 Possible SQL injection')).toBe('Possible SQL injection');
  });

  it('strips legacy bracketed severity/category tags', () => {
    expect(formatter.stripLeadingTags('[P0] [SECURITY] Possible SQL injection')).toBe('Possible SQL injection');
  });

  it('strips a leading bracketed BUG tag', () => {
    expect(formatter.stripLeadingTags('[BUG] Off-by-one error')).toBe('Off-by-one error');
  });

  it('strips bare (unbracketed) legacy tag words', () => {
    expect(formatter.stripLeadingTags('SECURITY: Possible SQL injection')).toBe('Possible SQL injection');
  });

  it('strips mixed emoji and bracketed tags together', () => {
    expect(formatter.stripLeadingTags('🐛 [P2] [BUG] Null pointer dereference')).toBe('Null pointer dereference');
  });

  it('leaves already-clean text untouched', () => {
    expect(formatter.stripLeadingTags('Possible SQL injection')).toBe('Possible SQL injection');
  });
});

describe('FormatterService.formatInlineComment', () => {
  it('includes the severity icon and title', () => {
    const output = formatter.formatInlineComment(comment({ severity: 'P0', title: 'SQL injection risk', body: 'Details here.' }));
    expect(output).toContain(`<img src="${BASE_URL}/icons/p0-icon.svg"`);
    expect(output).toContain('<strong>SQL injection risk</strong>');
    expect(output).toContain('Details here.');
  });

  it('uses emoji prefix when provider is "bitbucket" (D-13)', () => {
    const output = formatter.formatInlineComment(
      comment({ severity: 'P0', title: 'Bitbucket finding', body: 'Details here.' }),
      { provider: 'bitbucket' },
    );
    expect(output.startsWith('🚨 P0 ')).toBe(true);
    expect(output).not.toContain('<img ');
    expect(output).toContain('<strong>Bitbucket finding</strong>');
    expect(output).toContain('Details here.');
  });

  it('dedupes a body whose first line repeats the title', () => {
    const output = formatter.formatInlineComment(
      comment({ title: 'SQL injection risk', body: 'SQL injection risk\n\nUser input is concatenated into the query.' }),
    );
    expect(output).toBe(
      `${formatter.severityIcon('P1')} <strong>SQL injection risk</strong>\n\nUser input is concatenated into the query.`,
    );
    expect(output.match(/SQL injection risk/g)).toHaveLength(1);
  });

  it('dedupes when the title itself is a prefix of the first body line', () => {
    const output = formatter.formatInlineComment(
      comment({ title: 'SQL injection', body: 'SQL injection risk in query builder\n\nUser input is concatenated into the query.' }),
    );
    expect(output.match(/SQL injection/g)).toHaveLength(1);
    expect(output).toContain('User input is concatenated into the query.');
  });

  it('keeps the body intact when it does not duplicate the title', () => {
    const output = formatter.formatInlineComment(
      comment({ title: 'Null check missing', body: 'This value can be undefined at runtime.' }),
    );
    expect(output).toContain('<strong>Null check missing</strong>');
    expect(output).toContain('This value can be undefined at runtime.');
  });
});

describe('FormatterService.summarizeVerdict', () => {
  it('approves when there are no P0/P1/P2 comments and no failures', () => {
    expect(formatter.summarizeVerdict([comment({ severity: 'P3' }), comment({ severity: 'nit' })], false)).toEqual({
      verdict: 'approve',
      errors: 0,
      warnings: 0,
    });
  });

  it('requires comment verdict with P0 findings, counted as errors', () => {
    const result = formatter.summarizeVerdict([comment({ severity: 'P0' }), comment({ severity: 'P0' })], false);
    expect(result).toEqual({ verdict: 'comment', errors: 2, warnings: 0 });
  });

  it('requires comment verdict with P1 findings, counted as errors', () => {
    const result = formatter.summarizeVerdict([comment({ severity: 'P1' })], false);
    expect(result).toEqual({ verdict: 'comment', errors: 1, warnings: 0 });
  });

  it('requires comment verdict with P2 findings, counted as warnings only', () => {
    const result = formatter.summarizeVerdict([comment({ severity: 'P2' })], false);
    expect(result).toEqual({ verdict: 'comment', errors: 0, warnings: 1 });
  });

  it('requires comment verdict when hasFailures is true even with no comments', () => {
    expect(formatter.summarizeVerdict([], true)).toEqual({ verdict: 'comment', errors: 0, warnings: 0 });
  });
});

describe('FormatterService.formatReviewOverview', () => {
  it('truncates the commit sha to 10 characters and interpolates the bot username', () => {
    const output = formatter.formatReviewOverview('abcdef1234567890', 'codra-app');

    expect(output).toContain('**Reviewed commit:** `abcdef1234`');
    expect(output).toContain('@codra-app review');
    expect(output).toContain('@codra-app address that feedback');
    expect(output).toContain(`${BASE_URL}/repos`);
  });

  it('handles a short commit sha without throwing', () => {
    const output = formatter.formatReviewOverview('abc', 'codra-app');
    expect(output).toContain('**Reviewed commit:** `abc`');
  });

  // Thread C: the GitHub output must stay byte-identical whether provider is omitted or explicit.
  it('is byte-identical for the default path and explicit provider:"github"', () => {
    const def = formatter.formatReviewOverview('abcdef1234567890', 'codra-app');
    const gh = formatter.formatReviewOverview('abcdef1234567890', 'codra-app', { provider: 'github' });
    expect(gh).toBe(def);
    // Pin the GitHub-flavored surface so a future edit that drops it is caught.
    expect(gh).toContain('<details>');
    expect(gh).toContain('About Codra in GitHub');
    expect(gh).toContain('<br/>');
    expect(gh).toContain('react with 👍');
  });

  // Thread C: Bitbucket Cloud does not render GitHub-flavored HTML — emit clean CommonMark with
  // Bitbucket-accurate trigger copy (no <details>/<summary>/<br/>, no "in GitHub", no @mention/👍).
  it('emits clean Bitbucket markdown when provider is "bitbucket"', () => {
    const output = formatter.formatReviewOverview('abcdef1234567890', 'codra-app', { provider: 'bitbucket' });

    expect(output).toContain('### Codra Review');
    expect(output).toContain('**Reviewed commit:** `abcdef1234`');
    expect(output).toContain(`${BASE_URL}/repos`);

    // None of the GitHub-only HTML / copy leaks into the Bitbucket comment.
    expect(output).not.toContain('<details>');
    expect(output).not.toContain('<summary>');
    expect(output).not.toContain('<br/>');
    expect(output).not.toContain('in GitHub');
    expect(output).not.toContain('👍');
    expect(output).not.toContain('@codra-app');
  });
});

describe('FormatterService.formatOmittedCommentsNote', () => {
  it('emits a GitHub [!NOTE] callout for the default/github path (byte-identical)', () => {
    const def = formatter.formatOmittedCommentsNote(107, 10);
    const gh = formatter.formatOmittedCommentsNote(107, 10, { provider: 'github' });
    expect(gh).toBe(def);
    expect(gh).toBe(
      '> [!NOTE]\n> **107 comments were omitted** from this review to reduce noise and respect the configured `max_comments` limit (10). Showing the most critical issues.',
    );
  });

  it('emits a plain bold note for Bitbucket (no [!NOTE] callout syntax)', () => {
    const output = formatter.formatOmittedCommentsNote(107, 10, { provider: 'bitbucket' });
    expect(output).not.toContain('[!NOTE]');
    expect(output).toContain('**Note:**');
    expect(output).toContain('107 comments were omitted');
    expect(output).toContain('`max_comments` limit (10)');
  });
});
