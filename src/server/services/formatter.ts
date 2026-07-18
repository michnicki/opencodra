import type { ParsedReviewComment } from '@shared/schema';
import { reviewSeverities } from '@shared/schema';

// Defense-in-depth HTML escaper for the plain-text comment `title` before it is interpolated into
// a `<strong>...</strong>` tag. The title is plain text per schema (not model-authored Markdown),
// so escaping `<`/`&`/etc. cannot break intended formatting. This is NOT applied to `body`: the
// body is model-authored Markdown meant to render, and every sink already sanitizes it (VCS
// platforms + the dashboard's rehypeSanitize), so escaping it would corrupt intended formatting.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Provider discriminator consumed by `severityIcon` and forwarded by `formatInlineComment`. The
// formatter-level branch keeps the Bitbucket-specific emoji rendering isolated from the GitHub
// path so reviewers can see at a glance that the GitHub <img> output is byte-identical (D-13).
export type FormatterProvider = 'github' | 'bitbucket';
export type FormatterOptions = { provider?: FormatterProvider };

export class FormatterService {
  constructor(private baseUrl: string) {}

  severityIcon(severity: ParsedReviewComment['severity'], options?: FormatterOptions) {
    // D-13: Bitbucket has no native PR-label-style icon assets; emoji is the supported inline
    // rendering. The switch remains the same; only the per-case output changes when provider is
    // 'bitbucket'. Any other provider value (including the default 'github' / undefined path) uses
    // the existing <img> shape byte-identically.
    if (options?.provider === 'bitbucket') {
      switch (severity) {
        case 'P0':  return '🚨 P0';
        case 'P1':  return '⚠️ P1';
        case 'P2':  return '⚠️ P2';
        case 'P3':  return 'ℹ️ P3';
        case 'nit': return '💬 nit';
        default:    return '⚪';
      }
    }

    const iconBase = `${this.baseUrl}/icons`;
    const img = (name: string, alt: string) =>
      `<img src="${iconBase}/${name}-icon.svg" width="20" height="20" alt="${alt}" style="vertical-align:middle" />`;
    switch (severity) {
      case 'P0':  return img('p0',  'P0');
      case 'P1':  return img('p1',  'P1');
      case 'P2':  return img('p2',  'P2');
      case 'P3':  return img('p3',  'P3');
      case 'nit': return img('nit', 'nit');
      default:    return '⚪';
    }
  }

  /** Strip leading emoji / legacy tag prefixes from a string (same logic as model-output cleanText). */
  stripLeadingTags(text: string): string {
    let current = text.trim();
    let prev = '';
    while (current !== prev) {
      prev = current;
      current = current
        .replace(/^([\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}]|\[QUALITY\]|\[SECURITY\]|\[BUG\]|\[P[0-3]\]|\[NIT\]|QUALITY|SECURITY|BUG|P[0-3]|NIT|[:\-\s\uFE0F]|[^\w\s])+/giu, '')
        .trim();
    }
    return current;
  }

  formatInlineComment(comment: ParsedReviewComment, options?: FormatterOptions) {
    // Clean the body: strip any residual prefix tags, then remove a leading line
    // that duplicates the title (can happen with stale DB records).
    let body = this.stripLeadingTags(comment.body);
    const firstLine = body.split('\n')[0].trim();
    const cleanFirstLine = this.stripLeadingTags(firstLine);
    if (
      cleanFirstLine.toLowerCase().startsWith(comment.title.toLowerCase()) ||
      comment.title.toLowerCase().startsWith(cleanFirstLine.toLowerCase())
    ) {
      body = body.slice(firstLine.length).replace(/^[\n\r]+/, '');
    }

    // Escape the title only (defense-in-depth) — body is intentionally left as-is (sanitized
    // Markdown at every sink; escaping it would break rendering).
    return `${this.severityIcon(comment.severity, options)} <strong>${escapeHtml(comment.title)}</strong>\n\n${body}`;
  }

  summarizeVerdict(comments: ParsedReviewComment[], hasFailures: boolean) {
    const p0 = comments.filter((c) => c.severity === 'P0').length;
    const p1 = comments.filter((c) => c.severity === 'P1').length;
    const p2 = comments.filter((c) => c.severity === 'P2').length;

    if (p0 > 0 || p1 > 0 || hasFailures || p2 > 0) {
      return { verdict: 'comment' as const, errors: p0 + p1, warnings: p2 };
    }

    return { verdict: 'approve' as const, errors: 0, warnings: 0 };
  }

  /**
   * Assembles the "Review Overview" block posted to the PR (and rendered verbatim in the
   * dashboard job-detail panel via `summary_markdown`). Combines a best-effort AI `narrative`
   * with a deterministic recap (verdict, confidence, non-zero severity counts, up to 5 top
   * findings, and a files-reviewed/omitted footer) — see
   * docs/superpowers/specs/2026-07-19-review-overview-design.md §1.
   *
   * `commitSha` is accepted for interface parity with the design's input shape but intentionally
   * never rendered — the new format has no "Reviewed commit" line.
   */
  formatReviewOverview(
    input: {
      commitSha: string;
      botUsername: string;
      narrative: string | null;
      verdict: 'approve' | 'comment';
      confidenceScore: number | null;
      severityCounts: Record<ParsedReviewComment['severity'], number>;
      topFindings: Array<{ severity: ParsedReviewComment['severity']; title: string; path: string }>;
      filesReviewed: number;
      omittedCount: number;
      maxComments: number;
    },
    options?: FormatterOptions,
  ) {
    const {
      botUsername,
      narrative,
      verdict,
      confidenceScore,
      severityCounts,
      topFindings,
      filesReviewed,
      omittedCount,
    } = input;

    const totalFindings = reviewSeverities.reduce((sum, sev) => sum + (severityCounts[sev] ?? 0), 0);
    const zeroFindings = verdict === 'approve' && totalFindings === 0;

    const fileWord = `${filesReviewed} file${filesReviewed === 1 ? '' : 's'} reviewed`;
    const footer =
      omittedCount > 0
        ? `_${fileWord} · ${omittedCount} comments trimmed to ${input.maxComments}_`
        : `_${fileWord}_`;

    const sections: string[] = [];
    if (narrative && narrative.trim().length > 0) {
      sections.push(narrative.trim());
    }

    if (zeroFindings) {
      sections.push('**No issues found**');
    } else {
      const verdictLabel = verdict === 'approve' ? 'Approved' : 'Changes requested';
      const confidenceSuffix =
        confidenceScore !== null ? ` · Confidence ${Math.round(confidenceScore * 100)}%` : '';
      sections.push(`**Verdict:** ${verdictLabel}${confidenceSuffix}`);

      const countsLine = reviewSeverities
        .filter((sev) => (severityCounts[sev] ?? 0) > 0)
        .map((sev) => `${this.severityIcon(sev, { provider: 'bitbucket' })} ×${severityCounts[sev]}`)
        .join('  ');
      if (countsLine) {
        sections.push(countsLine);
      }

      if (topFindings.length > 0) {
        const findingLines = topFindings
          .map((f) => `- ${this.severityIcon(f.severity, options)} ${escapeHtml(f.title)} — \`${f.path}\``)
          .join('\n');
        sections.push(`**Top findings**\n${findingLines}`);
      }
    }

    sections.push(footer);

    const bodyBlock = sections.join('\n\n');

    // D-13 (Thread C): Bitbucket Cloud does not render GitHub-flavored HTML — <details>/<summary>/
    // <br/> are sanitized to junk, and the "in GitHub" copy plus @mention / draft / 👍 semantics
    // are GitHub-only. Emit clean CommonMark with Bitbucket-accurate trigger copy instead. The
    // GitHub branch below is byte-identical to the pre-Thread-C output (regression-guarded).
    if (options?.provider === 'bitbucket') {
      return `### OpenCodra Review

${bodyBlock}

[OpenCodra](${this.baseUrl}/repos) automatically reviews pull requests in this repository. A review runs when you open a pull request or push new commits to it.`;
    }

    return `### OpenCodra Review

${bodyBlock}

<details>
<summary>ℹ️ About OpenCodra</summary>

<br/>

[Your team has set up OpenCodra to review pull requests in this repo](${this.baseUrl}/repos). Reviews are triggered when you:

- **Open** a pull request for review
- **Mark** a draft as ready
- **Comment** "@${botUsername} review"

If OpenCodra has suggestions, it will comment; otherwise it will react with 👍.

OpenCodra can also answer questions or update the PR. Try commenting "@${botUsername} address that feedback".

</details>`;
  }
}
