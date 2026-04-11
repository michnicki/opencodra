import type { RepoConfig } from '@shared/schema';
import type { FileDiff } from '@server/core/diff';

export const FILE_REVIEW_SYSTEM_PROMPT = `You are a senior code reviewer for pull requests.
Return only valid JSON.
Do not use markdown fences.
Only comment on lines present in the diff.
Prefer actionable feedback.
Use severity values: error, warning, suggestion, nitpick.
Use category values: security, bugs, performance, correctness, quality.
When a fix is straightforward, provide code_suggestion without markdown fences.`;

export function buildFileReviewPrompt(input: {
  file: FileDiff;
  prTitle: string | null;
  prDescription: string | null;
  config: RepoConfig['review'];
}) {
  const focus = input.config.focus.join(', ');
  const rules = input.config.custom_rules.length > 0 ? input.config.custom_rules.map((rule) => `- ${rule}`).join('\n') : '- None';

  const diffText = [
    `PR title: ${input.prTitle ?? 'Untitled PR'}`,
    `PR description: ${input.prDescription ?? 'No description provided.'}`,
    `File path: ${input.file.path}`,
    `Review focus: ${focus}`,
    `Custom rules:\n${rules}`,
    '',
    'Return JSON in this shape:',
    `{"comments":[{"line":42,"position":12,"side":"RIGHT","severity":"warning","category":"quality","title":"Short title","body":"Markdown explanation","code_suggestion":"optional replacement"}],"file_verdict":"comment","file_summary":"One-sentence summary."}`,
    '',
    'Unified diff:',
    renderFileDiff(input.file),
  ];

  return diffText.join('\n');
}

function renderFileDiff(file: FileDiff) {
  const lines = [`diff --git a/${file.previousPath ?? file.path} b/${file.path}`];
  for (const hunk of file.hunks) {
    lines.push(hunk.header);
    for (const line of hunk.lines) {
      const prefix = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
      const left = line.oldLineNumber ?? '';
      const right = line.newLineNumber ?? '';
      lines.push(`${String(left).padStart(4, ' ')} ${String(right).padStart(4, ' ')} ${prefix}${line.content}`);
    }
  }

  return lines.join('\n');
}
