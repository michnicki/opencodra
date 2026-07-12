import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { JobsPage } from '@client/pages/jobs';
import { api } from '@client/lib/api';
import { renderPage } from './render';

vi.mock('@client/lib/api', () => ({
  api: {
    getJobs: vi.fn(),
    getDlqMessages: vi.fn(),
    getUpdatesEmailStatus: vi.fn(),
    subscribeUpdates: vi.fn(),
  },
}));

function makeJob(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: '1',
    owner: 'test-owner',
    repo: 'test-repo',
    prNumber: 101,
    prTitle: 'Fixing bug',
    status: 'done',
    trigger: 'auto',
    createdAt: new Date().toISOString(),
    commentCount: 2,
    ...overrides,
  } as any;
}

describe('JobsPage filters and pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getDlqMessages).mockResolvedValue({ messages: [], count: 0 });
    vi.mocked(api.getJobs).mockResolvedValue({ jobs: [makeJob()], total: 1 });
    vi.mocked(api.getUpdatesEmailStatus).mockResolvedValue({
      status: 'subscribed',
      email: 'user@example.com',
      updatedAt: new Date().toISOString(),
    });
  });

  it('renders jobs from the initial load', async () => {
    renderPage(<JobsPage />);

    expect(await screen.findByText('test-owner/test-repo')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Fixing bug' })).toBeInTheDocument();
  });

  it('sends the search term and resets to page 1', async () => {
    const user = userEvent.setup();
    renderPage(<JobsPage />);

    await screen.findByText('test-owner/test-repo');

    const searchInput = screen.getByPlaceholderText('Title or #number…');
    await user.type(searchInput, 'flaky');

    await waitFor(() => {
      const lastCall = vi.mocked(api.getJobs).mock.calls.at(-1)?.[0];
      expect(lastCall).toMatchObject({ search: 'flaky', offset: 0 });
    });
  });

  it('filters by status through the dropdown', async () => {
    const user = userEvent.setup();
    renderPage(<JobsPage />);

    await screen.findByText('test-owner/test-repo');

    await user.click(screen.getByRole('button', { name: /All statuses/i }));
    await user.click(await screen.findByRole('menuitem', { name: 'Done' }));

    await waitFor(() => {
      const lastCall = vi.mocked(api.getJobs).mock.calls.at(-1)?.[0];
      expect(lastCall).toMatchObject({ status: 'done', offset: 0 });
    });
  });

  it('shows a filtered empty state when no jobs match', async () => {
    vi.mocked(api.getJobs).mockResolvedValue({ jobs: [], total: 0 });
    const user = userEvent.setup();
    renderPage(<JobsPage />);

    const searchInput = await screen.findByPlaceholderText('Title or #number…');
    await user.type(searchInput, 'nonexistent');

    expect(await screen.findByText('No jobs match your filters. Try adjusting them.')).toBeInTheDocument();
  });

  it('paginates using the Next and Prev controls', async () => {
    vi.mocked(api.getJobs).mockResolvedValue({
      jobs: [makeJob()],
      total: 45, // 3 pages at limit=20
    });

    const user = userEvent.setup();
    renderPage(<JobsPage />);

    expect(await screen.findByText(/Page 1 of 3/)).toBeInTheDocument();
    const prevButton = screen.getByRole('button', { name: /Prev/i });
    expect(prevButton).toBeDisabled();

    await user.click(screen.getByRole('button', { name: /Next/i }));

    await waitFor(() => {
      const lastCall = vi.mocked(api.getJobs).mock.calls.at(-1)?.[0];
      expect(lastCall).toMatchObject({ offset: 20 });
    });
    expect(await screen.findByText(/Page 2 of 3/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Prev/i }));
    await waitFor(() => {
      const lastCall = vi.mocked(api.getJobs).mock.calls.at(-1)?.[0];
      expect(lastCall).toMatchObject({ offset: 0 });
    });
  });
});
