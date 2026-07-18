import { describe, expect, it } from 'vitest';
import { defaultRepoConfig, repoConfigRecordSchema, statsSchema } from '@shared/schema';

describe('repository provider API contracts', () => {
  it('requires a closed provider value on repository records', () => {
    const base = {
      installationId: '1',
      owner: 'acme',
      repo: 'widgets',
      parsedJson: defaultRepoConfig,
      updatedAt: new Date().toISOString(),
      lastJobCreatedAt: null,
      lastJobVerdict: null,
      mainModel: null,
      fallbackModels: null,
      sizeOverrides: null,
      enabled: true,
    };

    expect(repoConfigRecordSchema.parse({ ...base, vcsProvider: 'bitbucket' }).vcsProvider).toBe('bitbucket');
    expect(repoConfigRecordSchema.safeParse({ ...base, vcsProvider: 'gitlab' }).success).toBe(false);
  });

  it('preserves provider identity for top repository statistics', () => {
    const result = statsSchema.parse({
      totals: { jobs: 2, inputTokens: 0, outputTokens: 0, comments: 0 },
      trend: [],
      verdicts: [],
      models: [],
      topRepos: [
        { owner: 'acme', repo: 'widgets', vcsProvider: 'github', jobs: 1 },
        { owner: 'acme', repo: 'widgets', vcsProvider: 'bitbucket', jobs: 1 },
      ],
      statuses: [],
      triggers: [],
      severities: [],
      categories: [],
      performance: { avgDurationMs: null, p95DurationMs: null, avgConfidence: null },
    });

    expect(result.topRepos.map((repo) => repo.vcsProvider)).toEqual(['github', 'bitbucket']);
  });
});
