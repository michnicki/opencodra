import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { JobsPage } from '@client/pages/jobs';
import { api } from '@client/lib/api';
import { renderPage } from './render';
import type { JobSummary } from '@shared/schema';

vi.mock('@client/lib/api', () => ({
  api: {
    getJobs: vi.fn(),
    getUpdatesEmailStatus: vi.fn(),
    subscribeUpdates: vi.fn(),
  },
}));

function makeJob(overrides: Partial<JobSummary> = {}) {
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
  } as unknown as JobSummary;
}

describe('JobsPage filters and pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

    const searchInput = screen.getByPlaceholderText('Title or #number...');
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
    await user.click(await screen.findByRole('option', { name: 'Done' }));

    await waitFor(() => {
      const lastCall = vi.mocked(api.getJobs).mock.calls.at(-1)?.[0];
      expect(lastCall).toMatchObject({ status: 'done', offset: 0 });
    });
  });

  it('shows the empty state when no jobs are returned', async () => {
    vi.mocked(api.getJobs).mockResolvedValue({ jobs: [], total: 0 });
    const user = userEvent.setup();
    renderPage(<JobsPage />);

    const searchInput = await screen.findByPlaceholderText('Title or #number...');
    await user.type(searchInput, 'nonexistent');

    expect(await screen.findByText('No jobs yet')).toBeInTheDocument();
  });

  it('paginates using the Next and Previous page controls', async () => {
    vi.mocked(api.getJobs).mockResolvedValue({
      jobs: [makeJob()],
      total: 25, // 3 pages at the default itemsPerPage of 10
    });

    const user = userEvent.setup();
    renderPage(<JobsPage />);

    expect(await screen.findByText(/Page 1 of 3/)).toBeInTheDocument();
    const prevButton = screen.getByRole('button', { name: 'Previous page' });
    expect(prevButton).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Next page' }));

    await waitFor(() => {
      const lastCall = vi.mocked(api.getJobs).mock.calls.at(-1)?.[0];
      expect(lastCall).toMatchObject({ offset: 10 });
    });
    expect(await screen.findByText(/Page 2 of 3/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Previous page' }));
    await waitFor(() => {
      const lastCall = vi.mocked(api.getJobs).mock.calls.at(-1)?.[0];
      expect(lastCall).toMatchObject({ offset: 0 });
    });
  });
});
