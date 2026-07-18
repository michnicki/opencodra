import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { StatsPage } from '@client/pages/stats';
import { api } from '@client/lib/api';
import { renderPage } from './render';

vi.mock('@client/lib/api', () => ({
  api: {
    getStats: vi.fn(),
  },
}));

describe('StatsPage repository providers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getStats).mockResolvedValue({
      stats: {
        totals: { jobs: 5, inputTokens: 100, outputTokens: 50, comments: 3 },
        trend: [],
        verdicts: [],
        models: [],
        topRepos: [
          { owner: 'acme', repo: 'widgets', vcsProvider: 'github', jobs: 3 },
          { owner: 'acme', repo: 'widgets', vcsProvider: 'bitbucket', jobs: 2 },
        ],
        statuses: [],
        triggers: [],
        severities: [],
        categories: [],
        performance: { avgDurationMs: null, p95DurationMs: null, avgConfidence: null },
      },
    });
  });

  it('keeps same-named repositories visually distinct by provider', async () => {
    renderPage(<StatsPage />);

    expect(await screen.findAllByText('acme/widgets')).toHaveLength(2);
    expect(screen.getByRole('img', { name: 'GitHub' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Bitbucket' })).toBeInTheDocument();
  });
});
