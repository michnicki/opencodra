import { expect, it, describe, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { LoginPage } from '@client/pages/login';
import { DashboardPage } from '@client/pages/dashboard';
import { api } from '@client/lib/api';
import { renderPage } from './render';

// Mock the API client
vi.mock('@client/lib/api', () => ({
  api: {
    getSession: vi.fn(),
    getUpdatesEmailStatus: vi.fn(),
    subscribeUpdates: vi.fn(),
    getStats: vi.fn(),
    getJobs: vi.fn(),
  }
}));

describe('Frontend UI Flows', () => {

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getUpdatesEmailStatus).mockResolvedValue({
      status: 'subscribed',
      email: 'user@example.com',
      updatedAt: new Date().toISOString(),
    });
  });

  it('renders the GitHub sign-in flow', async () => {
    renderPage(<LoginPage />);

    const signInLink = screen.getByRole('link', { name: 'Sign in with GitHub' });
    expect(signInLink.getAttribute('href')).toBe('/auth/github');
  });

  it('displays the dashboard with stats and activity', async () => {
    vi.mocked(api.getStats).mockResolvedValue({
      stats: {
        totals: { jobs: 10, inputTokens: 500, outputTokens: 250, comments: 5 },
        trend: [],
        verdicts: [],
        models: [],
        topRepos: [],
        statuses: [],
        triggers: [],
        severities: [],
        categories: [],
        performance: { avgDurationMs: null, p95DurationMs: null, avgConfidence: null },
      }
    });

    vi.mocked(api.getJobs).mockResolvedValue({
      jobs: [
        {
          id: '1',
          owner: 'test-owner',
          repo: 'test-repo',
          prNumber: 101,
          prTitle: 'Fixing bug',
          status: 'done',
          trigger: 'auto',
          createdAt: new Date().toISOString(),
          commentCount: 2,
        }
      ] as any,
      total: 1
    });

    renderPage(<DashboardPage />);

    // Check for dashboard title (from PageHeader)
    expect(await screen.findByText('Dashboard')).toBeInTheDocument();

    // Check for stats totals (using data from getStats mock)
    expect(await screen.findByText('10')).toBeInTheDocument();
    expect(screen.getByText('500')).toBeInTheDocument();

    // Check for activity stream item
    expect(await screen.findByText('test-owner/test-repo')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Fixing bug' })).toBeInTheDocument();
  });
});
