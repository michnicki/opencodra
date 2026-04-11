import { findPositionForLine, filterReviewableFiles, getValidNewLines, parseUnifiedDiff } from '@server/core/diff';
import { defaultRepoConfig } from '@shared/schema';

const sampleDiff = `diff --git a/src/example.ts b/src/example.ts
index 1111111..2222222 100644
--- a/src/example.ts
+++ b/src/example.ts
@@ -1,3 +1,4 @@
 const answer = 41;
+const next = answer + 1;
 export function value() {
   return answer;
 }`;

describe('parseUnifiedDiff', () => {
  it('tracks new lines and GitHub positions', () => {
    const [file] = parseUnifiedDiff(sampleDiff);
    expect(file.path).toBe('src/example.ts');
    expect(file.lineCount).toBe(5);
    expect(getValidNewLines(file)).toEqual(new Set([1, 2, 3, 4, 5]));
    expect(findPositionForLine(file, 2)).toBe(2);
  });

  it('filters skipped files using config patterns', () => {
    const files = parseUnifiedDiff(sampleDiff);
    const filtered = filterReviewableFiles(files, {
      ...defaultRepoConfig.review,
      skip_files: ['src/**'],
    });
    expect(filtered).toHaveLength(0);
  });
});
