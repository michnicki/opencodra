import { fileReviewModelOutputSchema, parsedReviewCommentSchema, type ParsedReviewComment } from '@shared/schema';
import { findClosestValidLine, findPositionForLine, getValidNewLines, getValidPositions } from './diff';
import type { FileDiff } from './diff';
import { jsonrepair } from 'jsonrepair';

function extractJson(raw: string) {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    return fenced[1].trim();
  }

  const firstBrace = raw.indexOf('{');
  if (firstBrace === -1) {
    return raw.trim();
  }

  const lastBrace = raw.lastIndexOf('}');
  if (lastBrace > firstBrace) {
    return raw.slice(firstBrace, lastBrace + 1);
  }

  return raw.slice(firstBrace).trim();
}

/**
 * Pre-processes JSON string to handle common LLM defects before passing to jsonrepair.
 */
function preprocessJson(json: string): string {
  // Replace unescaped newlines within string values
  // This looks for content between quotes and escapes literal newlines
  return json.replace(/"([^"\\]*(?:\\.[^"\\]*)*)"/g, (match, content) => {
    return `"${content.replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
  });
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
  const extracted = extractJson(raw);
  const preprocessed = preprocessJson(extracted);
  
  let repaired = preprocessed;
  try {
    repaired = jsonrepair(preprocessed);
  } catch (e) {
    // If repair fails, we'll still try JSON.parse on preprocessed
  }

  const parsedJson = JSON.parse(repaired);
  const parsed = fileReviewModelOutputSchema.parse(parsedJson);
  const validLines = getValidNewLines(file);
  const validPositions = getValidPositions(file);

  const orphanedComments: string[] = [];
  const comments = parsed.comments
    .map((comment) => {
      let line = comment.line;
      let position = comment.position;

      // Try to validate line and find position
      if (line !== undefined && !validLines.has(line)) {
        // Line is invalid, try to find the closest valid one
        const closest = findClosestValidLine(file, line);
        if (closest !== undefined) {
          line = closest;
          position = findPositionForLine(file, line);
        } else {
          // Still could not find a good line
          line = undefined;
        }
      }

      if (position === undefined && line !== undefined) {
        position = findPositionForLine(file, line);
      }

      // Final validation
      if ((line !== undefined && !validLines.has(line)) || (position !== undefined && !validPositions.has(position)) || (line === undefined && position === undefined)) {
        orphanedComments.push(`- **Line ${comment.line || '?'}:** ${comment.title} - ${comment.body}`);
        return null;
      }

      return parsedReviewCommentSchema.parse({
        path: file.path,
        line: line,
        position,
        severity: comment.severity,
        category: comment.category,
        title: comment.title,
        body: withSuggestion(comment.body, comment.code_suggestion),
        codeSuggestion: comment.code_suggestion,
      });
    })
    .filter((comment): comment is ParsedReviewComment => Boolean(comment));

  let fileSummary = parsed.file_summary;
  if (orphanedComments.length > 0) {
    fileSummary += `\n\n### Additional Feedback\n${orphanedComments.join('\n')}`;
  }

  return {
    comments,
    verdict: parsed.file_verdict,
    fileSummary: fileSummary,
  };
}
