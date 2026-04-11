import { fileReviewModelOutputSchema, parsedReviewCommentSchema, type ParsedReviewComment } from '@shared/schema';
import { findPositionForLine, getValidNewLines, getValidPositions } from './diff';
import type { FileDiff } from './diff';

function extractJson(raw: string) {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    return fenced[1].trim();
  }

  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return raw.slice(firstBrace, lastBrace + 1);
  }

  return raw.trim();
}

function withSuggestion(body: string, codeSuggestion?: string) {
  if (!codeSuggestion) {
    return body;
  }

  return `${body}\n\n\`\`\`suggestion\n${codeSuggestion}\n\`\`\``;
}

export function parseFileReviewResponse(raw: string, file: FileDiff): {
  comments: ParsedReviewComment[];
  verdict: 'approve' | 'comment' | 'request_changes';
  fileSummary: string;
} {
  const parsedJson = JSON.parse(extractJson(raw));
  const parsed = fileReviewModelOutputSchema.parse(parsedJson);
  const validLines = getValidNewLines(file);
  const validPositions = getValidPositions(file);

  const comments = parsed.comments
    .map((comment) => {
      const position =
        comment.position ??
        (comment.line !== undefined ? findPositionForLine(file, comment.line) : undefined);

      if ((comment.line !== undefined && !validLines.has(comment.line)) || (position !== undefined && !validPositions.has(position))) {
        return null;
      }

      return parsedReviewCommentSchema.parse({
        path: file.path,
        line: comment.line,
        position,
        severity: comment.severity,
        category: comment.category,
        title: comment.title,
        body: withSuggestion(comment.body, comment.code_suggestion),
        codeSuggestion: comment.code_suggestion,
      });
    })
    .filter((comment): comment is ParsedReviewComment => Boolean(comment));

  return {
    comments,
    verdict: parsed.file_verdict,
    fileSummary: parsed.file_summary,
  };
}
