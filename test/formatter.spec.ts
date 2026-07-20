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

  // Defense-in-depth: the plain-text title is HTML-escaped before interpolation into <strong>.
  it('HTML-escapes special characters in the title only, leaving the body untouched', () => {
    const output = formatter.formatInlineComment(
      comment({
        title: '<script>alert(1)</script> & "risky"',
        body: 'Use `<div>` & keep **markdown** intact.',
      }),
    );
    // Title is escaped inside <strong>...</strong>.
    expect(output).toContain('<strong>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;risky&quot;</strong>');
    expect(output).not.toContain('<script>alert(1)</script>');
    // Body is left as-authored (Markdown that downstream sinks sanitize/render).
    expect(output).toContain('Use `<div>` & keep **markdown** intact.');
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
  function overviewInput(overrides: Partial<Parameters<FormatterService['formatReviewOverview']>[0]> = {}) {
    return {
      commitSha: 'abcdef1234567890',
      botUsername: 'codra-app',
      narrative: null as string | null,
      verdict: 'comment' as const,
      confidenceScore: null as number | null,
      severityCounts: { P0: 0, P1: 0, P2: 0, P3: 0, nit: 0 },
      topFindings: [] as Array<{ severity: ParsedReviewComment['severity']; title: string; path: string }>,
      filesReviewed: 3,
      omittedCount: 0,
      maxComments: 10,
      ...overrides,
    };
  }

  it('handles a short commit sha without throwing', () => {
    expect(() => formatter.formatReviewOverview(overviewInput({ commitSha: 'abc' }))).not.toThrow();
  });

  it('never renders a "Reviewed commit" line', () => {
    const output = formatter.formatReviewOverview(overviewInput());
    expect(output).not.toContain('Reviewed commit');
  });

  // (a) findings present
  it('renders verdict, confidence, non-zero counts in P0..nit order, and top findings', () => {
    const output = formatter.formatReviewOverview(
      overviewInput({
        verdict: 'comment',
        confidenceScore: 0.82,
        severityCounts: { P0: 1, P1: 2, P2: 0, P3: 0, nit: 0 },
        topFindings: [
          { severity: 'P0', title: 'SQL injection risk', path: 'src/index.ts' },
          { severity: 'P1', title: 'Missing null check', path: 'src/util.ts' },
        ],
      }),
    );

    expect(output).toContain('**Verdict:** Changes requested');
    expect(output).toContain('Confidence 82%');
    expect(output).toContain('**Top findings**');

    const p0Index = output.indexOf('P0');
    const p1Index = output.indexOf('P1');
    expect(p0Index).toBeGreaterThan(-1);
    expect(p1Index).toBeGreaterThan(p0Index);

    expect(output).toContain('SQL injection risk');
    expect(output).toContain('`src/index.ts`');
  });

  it('omits the confidence readout when confidenceScore is null', () => {
    const output = formatter.formatReviewOverview(
      overviewInput({ severityCounts: { P0: 1, P1: 0, P2: 0, P3: 0, nit: 0 } }),
    );
    expect(output).not.toContain('Confidence');
  });

  it('renders GitHub <img> icons for top findings on the github/default path', () => {
    const output = formatter.formatReviewOverview(
      overviewInput({
        severityCounts: { P0: 1, P1: 0, P2: 0, P3: 0, nit: 0 },
        topFindings: [{ severity: 'P0', title: 'SQL injection risk', path: 'src/index.ts' }],
      }),
    );
    expect(output).toContain('<img');
  });

  it('renders emoji icons for top findings on the bitbucket path', () => {
    const output = formatter.formatReviewOverview(
      overviewInput({
        severityCounts: { P0: 1, P1: 0, P2: 0, P3: 0, nit: 0 },
        topFindings: [{ severity: 'P0', title: 'SQL injection risk', path: 'src/index.ts' }],
      }),
      { provider: 'bitbucket' },
    );
    expect(output).not.toContain('<img');
    expect(output).toContain('🚨 P0');
  });

  // (b) zero findings + approve
  it('renders "No issues found" with no verdict/counts/top-findings when there are zero findings and verdict is approve', () => {
    const output = formatter.formatReviewOverview(overviewInput({ verdict: 'approve' }));
    expect(output).toContain('**No issues found**');
    expect(output).not.toContain('**Verdict:**');
    expect(output).not.toContain('**Top findings**');
    expect(output).toContain('3 files reviewed');
  });

  // (c) omitted-count footer
  it('includes "comments trimmed to" in the footer only when omittedCount > 0', () => {
    const withOmitted = formatter.formatReviewOverview(
      overviewInput({ omittedCount: 97, maxComments: 10, filesReviewed: 7 }),
    );
    expect(withOmitted).toContain('comments trimmed to');
    expect(withOmitted).toContain('7 files reviewed');

    const withoutOmitted = formatter.formatReviewOverview(overviewInput({ omittedCount: 0 }));
    expect(withoutOmitted).not.toContain('comments trimmed to');
  });

  // (c2) commands-feature footer (D-10 skipped-for-size line + D-11 commands hint, Plan 11-05)
  it('adds NOTHING to the footer when the commands feature is off (byte-identical, NREG-01)', () => {
    const off = formatter.formatReviewOverview(overviewInput());
    const explicitOff = formatter.formatReviewOverview(
      overviewInput({ commandsEnabled: false, skippedForSizeCount: 5 }),
    );
    // Even with a non-zero skipped count, a disabled feature renders neither line.
    expect(explicitOff).toBe(off);
    expect(off).not.toContain('Commands:');
    expect(off).not.toContain('skipped for size');
  });

  it('shows the "Commands: review · pause · help" hint whenever the feature is enabled, regardless of omissions (D-11, Codex 11-05 MED)', () => {
    const enabledNoSkips = formatter.formatReviewOverview(
      overviewInput({ commandsEnabled: true, skippedForSizeCount: 0 }),
    );
    expect(enabledNoSkips).toContain('Commands: review · pause · help');
    // With zero omissions ONLY the hint is added, never the skipped line.
    expect(enabledNoSkips).not.toContain('skipped for size');
  });

  it('adds the "N files skipped for size — comment @bot review-rest" line only when enabled AND omissions exist (D-10)', () => {
    const withSkips = formatter.formatReviewOverview(
      overviewInput({ commandsEnabled: true, skippedForSizeCount: 3, botUsername: 'codra-app' }),
    );
    expect(withSkips).toContain('3 files skipped for size — comment @codra-app review-rest');
    expect(withSkips).toContain('Commands: review · pause · help');

    // Singular file wording.
    const singular = formatter.formatReviewOverview(
      overviewInput({ commandsEnabled: true, skippedForSizeCount: 1, botUsername: 'codra-app' }),
    );
    expect(singular).toContain('1 file skipped for size — comment @codra-app review-rest');
  });

  // (d) narrative null vs present
  it('starts directly with the recap when narrative is null or empty (no stray blank narrative line)', () => {
    const nullNarrative = formatter.formatReviewOverview(overviewInput({ narrative: null, verdict: 'approve' }));
    const emptyNarrative = formatter.formatReviewOverview(overviewInput({ narrative: '', verdict: 'approve' }));
    expect(nullNarrative).not.toMatch(/### OpenCodra Review\n\n\n/);
    expect(emptyNarrative).not.toMatch(/### OpenCodra Review\n\n\n/);
  });

  it('includes the narrative text verbatim when present', () => {
    const output = formatter.formatReviewOverview(
      overviewInput({ narrative: 'This PR tightens input validation across the API layer.', verdict: 'approve' }),
    );
    expect(output).toContain('This PR tightens input validation across the API layer.');
  });

  // (e) GitHub vs Bitbucket
  it('is byte-identical for the default path and explicit provider:"github"', () => {
    const def = formatter.formatReviewOverview(overviewInput());
    const gh = formatter.formatReviewOverview(overviewInput(), { provider: 'github' });
    expect(gh).toBe(def);
    expect(gh).toContain('<details>');
    expect(gh).toContain('<summary>');
    expect(gh).toContain('<br/>');
    expect(gh).toContain('About OpenCodra');
  });

  it('emits clean Bitbucket markdown with no <details>/<summary>/<br/>/"About OpenCodra", but keeps a flat About-equivalent paragraph', () => {
    const output = formatter.formatReviewOverview(overviewInput(), { provider: 'bitbucket' });

    expect(output).toContain('### OpenCodra Review');
    expect(output).not.toContain('<details>');
    expect(output).not.toContain('<summary>');
    expect(output).not.toContain('<br/>');
    expect(output).not.toContain('<img');
    expect(output).toContain(`${BASE_URL}/repos`);
    expect(output).toContain('automatically reviews pull requests');
  });
});

describe('FormatterService.formatWalkthrough (WT-02/WT-03/D-04/D-13)', () => {
  type Severity = ParsedReviewComment['severity'];
  const zeroCounts = (): Record<Severity, number> => ({ P0: 0, P1: 0, P2: 0, P3: 0, nit: 0 });

  function walkInput(
    overrides: Partial<Parameters<FormatterService['formatWalkthrough']>[0]> = {},
  ): Parameters<FormatterService['formatWalkthrough']>[0] {
    return {
      files: [
        { path: 'src/a.ts', summary: 'Explains change A.', counts: { ...zeroCounts(), P1: 1 } },
        { path: 'src/b.ts', summary: 'Explains change B.', counts: { ...zeroCounts(), nit: 2 } },
      ],
      severityCounts: { ...zeroCounts(), P1: 1, nit: 2 },
      filesReviewed: 2,
      mermaid: null,
      ...overrides,
    };
  }

  const MERMAID = 'sequenceDiagram\n  A->>B: hello';

  it('renders a ```mermaid fence on GitHub when a non-null mermaid arg is passed', () => {
    const body = formatter.formatWalkthrough(walkInput({ mermaid: MERMAID }));
    expect(body).toContain('```mermaid');
    expect(body).toContain('A->>B: hello');
  });

  it('NEVER renders a mermaid fence on Bitbucket even when a mermaid arg is passed (WT-03/D-13)', () => {
    const body = formatter.formatWalkthrough(walkInput({ mermaid: MERMAID }), {
      provider: 'bitbucket',
    });
    expect(body).not.toContain('```mermaid');
    expect(body).not.toContain('A->>B: hello');
  });

  it.each(['github', 'bitbucket'] as const)(
    'renders per-severity counts and one row per file on %s (WT-02)',
    (provider) => {
      const body = formatter.formatWalkthrough(walkInput(), { provider });
      // per-severity totals line present (emoji counts)
      expect(body).toContain('×1');
      expect(body).toContain('×2');
      // a table row per file
      expect(body).toContain('src/a.ts');
      expect(body).toContain('src/b.ts');
      expect(body).toContain('| File | Summary | Findings |');
    },
  );

  it('renders a summary containing |, backtick, and newline as exactly one intact row', () => {
    const hostile = 'first | col `code`\nsecond line | more';
    const body = formatter.formatWalkthrough(
      walkInput({
        files: [{ path: 'src/x.ts', summary: hostile, counts: zeroCounts() }],
        severityCounts: zeroCounts(),
        filesReviewed: 1,
      }),
    );
    // the raw pipe/backtick are escaped; the newline is flattened
    expect(body).not.toContain('first | col');
    expect(body).toContain('first \\| col');
    expect(body).toContain('\\`code\\`');
    expect(body).not.toContain('second line | more');
    expect(body).toContain('second line \\| more');
    // exactly one data row: header + separator + 1 row => the src/x.ts path appears once
    const rowLines = body.split('\n').filter((l) => l.startsWith('| ') && l.includes('src/x.ts'));
    expect(rowLines).toHaveLength(1);
  });

  it('caps at WALKTHROUGH_FILE_CAP rows and collapses the remainder (D-04)', () => {
    const CAP = 30;
    const files = Array.from({ length: CAP + 5 }, (_, i) => ({
      path: `src/file-${i}.ts`,
      summary: `summary ${i}`,
      counts: zeroCounts(),
    }));
    const body = formatter.formatWalkthrough(
      walkInput({ files, severityCounts: zeroCounts(), filesReviewed: files.length }),
    );
    const dataRows = body
      .split('\n')
      .filter((l) => l.startsWith('| src/file-'));
    expect(dataRows).toHaveLength(CAP);
    expect(body).toContain('+5 more files reviewed');
  });

  it('keeps the body under WALKTHROUGH_BODY_MAX for a pathological large-summary input', () => {
    const bigSummary = 'x'.repeat(8_000);
    const files = Array.from({ length: 30 }, (_, i) => ({
      path: `src/file-${i}.ts`,
      summary: bigSummary,
      counts: zeroCounts(),
    }));
    const body = formatter.formatWalkthrough(
      walkInput({ files, severityCounts: zeroCounts(), filesReviewed: files.length }),
    );
    expect(body.length).toBeLessThanOrEqual(60_000);
  });

  it('renders coverage + counts with an empty summary and null mermaid, no throw (D-02/D-04a)', () => {
    const body = formatter.formatWalkthrough(
      walkInput({
        files: [{ path: 'src/empty.ts', summary: '', counts: zeroCounts() }],
        severityCounts: zeroCounts(),
        filesReviewed: 1,
        mermaid: null,
      }),
    );
    expect(body).toContain('src/empty.ts');
    expect(body).toContain('1 file reviewed');
    expect(body).not.toContain('```mermaid');
  });
});
