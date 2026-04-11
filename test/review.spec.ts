import { extractReviewRequest } from '@server/core/review';
import { defaultRepoConfig } from '@shared/schema';

describe('extractReviewRequest', () => {
  it('accepts PR opened events when config allows them', () => {
    const result = extractReviewRequest({
      eventName: 'pull_request',
      config: defaultRepoConfig,
      botUsername: 'codra-app',
      payload: {
        action: 'opened',
        installation: { id: 1 },
        repository: { owner: { login: 'openai' }, name: 'codra' },
        pull_request: {
          number: 7,
          title: 'Improve queue worker',
          user: { login: 'devar' },
          head: { sha: 'abc', ref: 'feature' },
          base: { sha: 'def', ref: 'main' },
          draft: false,
          body: 'Test PR',
        },
      },
    });

    expect(result?.trigger).toBe('auto');
    expect(result?.prNumber).toBe(7);
  });

  it('accepts mention triggers on issue comments for PRs', () => {
    const result = extractReviewRequest({
      eventName: 'issue_comment',
      config: defaultRepoConfig,
      botUsername: 'codra-app',
      payload: {
        action: 'created',
        installation: { id: 1 },
        repository: { owner: { login: 'openai' }, name: 'codra' },
        issue: { number: 8, pull_request: { url: 'https://api.github.com/repos/openai/codra/pulls/8' } },
        comment: { body: 'please check this @codra-app' },
      },
    });

    expect(result?.trigger).toBe('mention');
    expect(result?.prNumber).toBe(8);
  });
});
