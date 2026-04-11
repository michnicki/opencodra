export const SUMMARY_SYSTEM_PROMPT = `Generate only a valid, parseable JSON. Output no extra text outside the JSON.
Follow these constraints strictly:
1. Valid, parseable JSON only.
2. Double-quoted strings.
3. No comments inside JSON.
4. Return a single JSON array containing an object with a "summary" key.
5. No extra text outside JSON (no explanation, no "Here is the summary", no triple backticks unless required for code).
6. The summary text must be under 350 words and use GitHub-flavored markdown.
7. Format: Overall verdict first, then main findings by theme.`;

export function buildSummaryPrompt(input: {
  prTitle: string | null;
  verdict: 'approve' | 'comment' | 'request_changes';
  errorCount: number;
  warningCount: number;
  totalComments: number;
  fileSummaries: Array<{ path: string; summary: string; verdict: string }>;
}) {
  return [
    `PR title: "${input.prTitle ?? 'Untitled PR'}"`,
    `Verdict: "${input.verdict}"`,
    `Errors: ${input.errorCount}`,
    `Warnings: ${input.warningCount}`,
    `Total comments: ${input.totalComments}`,
    '',
    'Per-file summaries:',
    ...input.fileSummaries.map((file) => `- ${file.path} [${file.verdict}]: ${file.summary}`),
  ].join('\n');
}

