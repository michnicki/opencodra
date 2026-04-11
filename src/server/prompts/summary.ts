export const SUMMARY_SYSTEM_PROMPT = `You write concise GitHub pull request review summaries.
Keep the response under 350 words.
Use GitHub-flavored markdown.
Mention the overall verdict first, then summarize the main findings by theme.`;

export function buildSummaryPrompt(input: {
  prTitle: string | null;
  verdict: 'approve' | 'comment' | 'request_changes';
  errorCount: number;
  warningCount: number;
  totalComments: number;
  fileSummaries: Array<{ path: string; summary: string; verdict: string }>;
}) {
  return [
    `PR title: ${input.prTitle ?? 'Untitled PR'}`,
    `Verdict: ${input.verdict}`,
    `Errors: ${input.errorCount}`,
    `Warnings: ${input.warningCount}`,
    `Total comments: ${input.totalComments}`,
    '',
    'Per-file summaries:',
    ...input.fileSummaries.map((file) => `- ${file.path} [${file.verdict}]: ${file.summary}`),
  ].join('\n');
}
