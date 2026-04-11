export const SUMMARY_SYSTEM_PROMPT = `You are writing the body of a GitHub pull request review comment left by an automated code review bot.
Output only a single valid JSON array containing one object with a "summary" key. No text outside the JSON.

Rules:
1. Valid JSON only. Double-quoted strings. No comments inside JSON.
2. The summary value is a GitHub-flavored markdown string.
3. Under 250 words. Be specific and technical — cite actual file names and issues.
4. Do NOT include generic filler like "overall the code looks good" unless ALL files passed with no issues.
5. Start with ONE line: "✅ **Approved**" or "💬 **Comments posted**" — nothing else on that line.
6. Then a blank line, then list concrete findings per file using bold file names.
7. For files that could not be reviewed due to errors, note them briefly (e.g. "⚠️ \`file.js\` — automated review could not complete (parse error).").
8. If no meaningful findings exist but the verdict is "approve", write a short positive sentence.`;

export function buildSummaryPrompt(input: {
  prTitle: string | null;
  verdict: 'approve' | 'comment';
  fileSummaries: Array<{ path: string; summary: string; verdict: string }>;
}) {
  const successFindings = input.fileSummaries.filter(
    (f) => f.verdict !== 'approve' && !f.summary.startsWith('Review failed'),
  );
  const approved = input.fileSummaries.filter((f) => f.verdict === 'approve');
  const failures = input.fileSummaries.filter((f) => f.summary.startsWith('Review failed'));

  const lines: string[] = [
    `PR: "${input.prTitle ?? 'Untitled PR'}"`,
    `Verdict: ${input.verdict}`,
    '',
  ];

  if (successFindings.length > 0) {
    lines.push('Files with findings:');
    for (const f of successFindings) {
      lines.push(`- \`${f.path}\` [${f.verdict}]: ${f.summary}`);
    }
  }

  if (approved.length > 0) {
    lines.push(`Files approved with no issues: ${approved.map((f) => `\`${f.path}\``).join(', ')}`);
  }

  if (failures.length > 0) {
    lines.push('Files where automated review failed (mention as warnings):');
    for (const f of failures) {
      const reason = f.summary.replace('Review failed: ', '');
      lines.push(`- \`${f.path}\`: ${reason}`);
    }
  }

  if (successFindings.length === 0 && failures.length === 0) {
    lines.push('No significant findings. All files passed review.');
  }

  return lines.join('\n');
}


