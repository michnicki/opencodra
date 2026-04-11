import { parseUnifiedDiff } from '@server/core/diff';
import { parseFileReviewResponse } from '@server/core/model-output';

const diff = `diff --git a/src/example.ts b/src/example.ts
index 1111111..2222222 100644
--- a/src/example.ts
+++ b/src/example.ts
@@ -1,1 +1,2 @@
 export const one = 1;
+export const two = 2;`;

describe('parseFileReviewResponse', () => {
  it('extracts fenced json and drops invalid lines', () => {
    const [file] = parseUnifiedDiff(diff);
    const raw = [
      '```json',
      JSON.stringify({
        comments: [
          {
            line: 2,
            severity: 'warning',
            category: 'quality',
            title: 'Use a named constant',
            body: 'Consider reusing an existing constant.',
            code_suggestion: 'export const two = ONE + 1;',
          },
          {
            line: 99,
            severity: 'warning',
            category: 'quality',
            title: 'Invalid line',
            body: 'This should be dropped.',
          },
        ],
        file_verdict: 'comment',
        file_summary: 'One follow-up suggested.',
      }),
      '```',
    ].join('\n');

    const parsed = parseFileReviewResponse(raw, file);
    expect(parsed.verdict).toBe('comment');
    expect(parsed.comments).toHaveLength(1);
    expect(parsed.comments[0].position).toBe(2);
    expect(parsed.comments[0].body).toContain('```suggestion');
  });
});
