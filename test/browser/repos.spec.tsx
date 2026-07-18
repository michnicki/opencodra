import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReposPage } from '@client/pages/repos';
import { api } from '@client/lib/api';
import { renderPage } from './render';
import type { RepoConfigRecord } from '@shared/schema';

vi.mock('@client/lib/api', () => ({
  api: {
    getRepos: vi.fn(),
    getGlobalConfig: vi.fn(),
    getModelConfigs: vi.fn(),
    updateRepoConfig: vi.fn(),
    syncRepos: vi.fn(),
  },
}));

const REPO: RepoConfigRecord = {
  installationId: '1',
  owner: 'acme',
  repo: 'widgets',
  vcsProvider: 'github',
  parsedJson: {} as any,
  updatedAt: new Date().toISOString(),
  lastJobCreatedAt: null,
  lastJobVerdict: null,
  mainModel: null,
  fallbackModels: null,
  sizeOverrides: null,
  enabled: true,
};

describe('ReposPage repository management', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getRepos).mockResolvedValue({ repos: [REPO] });
    vi.mocked(api.getGlobalConfig).mockResolvedValue({ config: { main: null, fallbacks: [], size_overrides: [] } });
    vi.mocked(api.getModelConfigs).mockResolvedValue({ providers: [], configs: [], syncErrors: [] });
  });

  it('renders the repo list with its enabled state', async () => {
    renderPage(<ReposPage />);

    expect(await screen.findByText('acme/widgets')).toBeInTheDocument();
    expect(screen.getByText('Enabled')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'GitHub' })).toHaveAttribute('title', 'GitHub');
  });

  it('distinguishes same-named repositories by provider', async () => {
    vi.mocked(api.getRepos).mockResolvedValue({
      repos: [REPO, { ...REPO, installationId: '2', vcsProvider: 'bitbucket' }],
    });

    renderPage(<ReposPage />);

    expect(await screen.findAllByText('acme/widgets')).toHaveLength(2);
    expect(screen.getByRole('img', { name: 'GitHub' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Bitbucket' })).toHaveAttribute('title', 'Bitbucket');
  });

  it('toggling the enabled switch patches the repo config', async () => {
    vi.mocked(api.updateRepoConfig).mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    renderPage(<ReposPage />);

    await screen.findByText('acme/widgets');

    await user.click(screen.getByRole('checkbox', { name: 'Pause reviews for acme/widgets' }));

    await waitFor(() => {
      expect(api.updateRepoConfig).toHaveBeenCalledWith('acme', 'widgets', { enabled: false });
    });
  });

  it('syncing repositories calls the sync endpoint and reloads the list', async () => {
    vi.mocked(api.syncRepos).mockResolvedValue({ ok: true, synced: ['acme/widgets'] });
    const user = userEvent.setup();
    renderPage(<ReposPage />);

    await screen.findByText('acme/widgets');
    vi.mocked(api.getRepos).mockClear();

    await user.click(screen.getByRole('button', { name: /Sync/i }));

    await waitFor(() => {
      expect(api.syncRepos).toHaveBeenCalled();
      expect(api.getRepos).toHaveBeenCalled();
    });
  });
});
