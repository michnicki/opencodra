import { buildFileReviewPrompts } from '@server/prompts/file-review';
import type { FileDiff } from '@server/core/diff';
import { defaultRepoConfig } from '@shared/schema';

describe('File Review Prompt — per-finding confidence', () => {
  const file: FileDiff = {
    path: 'src/example.ts',
    previousPath: null,
    isNew: false,
    isDeleted: false,
    isBinary: false,
    lineCount: 3,
    hunks: [
      {
        header: '@@ -1,2 +1,3 @@',
        lines: [
          { kind: 'context', content: 'const a = 1;', newLineNumber: 1, position: 1 },
          { kind: 'add', content: 'const b = a + 1;', newLineNumber: 2, position: 2 },
        ],
      },
    ],
  };

  it('requests confidence_score in both the system and user prompts', () => {
    const result = buildFileReviewPrompts({
      file,
      prTitle: 'Example PR',
      prDescription: null,
      config: defaultRepoConfig.review,
    });

    expect(result.systemPrompt).toContain('confidence_score');
    expect(result.userPrompt).toContain('confidence_score');
  });

  it('instructs the model to omit findings when in doubt', () => {
    const result = buildFileReviewPrompts({
      file,
      prTitle: 'Example PR',
      prDescription: null,
      config: defaultRepoConfig.review,
    });

    expect(result.systemPrompt.toLowerCase()).toContain('when in doubt');
  });
});
