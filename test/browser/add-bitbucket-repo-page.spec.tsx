import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AddBitbucketRepoPage } from '@client/pages/repos/add-bitbucket';
import { api } from '@client/lib/api';
import { renderPage } from './render';

const navigateMock = vi.fn();

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigateMock };
});

vi.mock('@client/lib/api', () => ({
  api: {
    addBitbucketRepo: vi.fn(),
  },
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();

vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

describe('AddBitbucketRepoPage (D-31)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders all 5 fields with correct labels and input types', () => {
    renderPage(<AddBitbucketRepoPage />, { route: '/repos/add/bitbucket' });

    expect(screen.getByText('Workspace')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('my-workspace')).toHaveAttribute('type', 'text');

    expect(screen.getByText('Repo slug')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('my-repo')).toHaveAttribute('type', 'text');

    expect(screen.getByText('Bitbucket access token')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Repository or Workspace Access Token')).toHaveAttribute('type', 'password');

    expect(screen.getByText('Webhook secret')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Per-repo webhook secret')).toHaveAttribute('type', 'password');

    expect(screen.getByText('Token expires at (optional)')).toBeInTheDocument();
  });

  it('builds the inline help webhook URL from window.location.origin, not APP_URL', () => {
    renderPage(<AddBitbucketRepoPage />, { route: '/repos/add/bitbucket' });

    const expectedUrl = `${window.location.origin}/webhook/bitbucket`;
    expect(screen.getByText(new RegExp(expectedUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeInTheDocument();
  });

  it('disables the submit button until workspace/repoSlug/accessToken/webhookSecret are all filled', async () => {
    const user = userEvent.setup();
    renderPage(<AddBitbucketRepoPage />, { route: '/repos/add/bitbucket' });

    const submitButton = screen.getByRole('button', { name: /Add repository/i });
    expect(submitButton).toBeDisabled();

    await user.type(screen.getByPlaceholderText('my-workspace'), 'my-ws');
    await user.type(screen.getByPlaceholderText('my-repo'), 'my-repo');
    expect(submitButton).toBeDisabled();

    await user.type(screen.getByPlaceholderText('Repository or Workspace Access Token'), 'tok-value');
    expect(submitButton).toBeDisabled();

    await user.type(screen.getByPlaceholderText('Per-repo webhook secret'), 'sec-value');
    expect(submitButton).not.toBeDisabled();
  });

  it('navigates to /repos and shows a success toast on a successful submit', async () => {
    vi.mocked(api.addBitbucketRepo).mockResolvedValue({
      credential: {
        vcsProvider: 'bitbucket',
        workspace: 'my-ws',
        repoSlug: 'my-repo',
        hasToken: true,
        hasWebhookSecret: true,
        tokenExpiresAt: null,
        label: null,
        status: 'valid',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    });

    const user = userEvent.setup();
    renderPage(<AddBitbucketRepoPage />, { route: '/repos/add/bitbucket' });

    await user.type(screen.getByPlaceholderText('my-workspace'), 'my-ws');
    await user.type(screen.getByPlaceholderText('my-repo'), 'my-repo');
    await user.type(screen.getByPlaceholderText('Repository or Workspace Access Token'), 'tok-value');
    await user.type(screen.getByPlaceholderText('Per-repo webhook secret'), 'sec-value');
    await user.click(screen.getByRole('button', { name: /Add repository/i }));

    await waitFor(() => {
      expect(api.addBitbucketRepo).toHaveBeenCalledWith({
        workspace: 'my-ws',
        repoSlug: 'my-repo',
        accessToken: 'tok-value',
        webhookSecret: 'sec-value',
        tokenExpiresAt: null,
      });
      expect(toastSuccess).toHaveBeenCalled();
      expect(navigateMock).toHaveBeenCalledWith('/repos');
    });
  });

  it('shows an inline destructive alert and error toast on a failed submit', async () => {
    vi.mocked(api.addBitbucketRepo).mockRejectedValue(new Error('duplicate row'));

    const user = userEvent.setup();
    renderPage(<AddBitbucketRepoPage />, { route: '/repos/add/bitbucket' });

    await user.type(screen.getByPlaceholderText('my-workspace'), 'my-ws');
    await user.type(screen.getByPlaceholderText('my-repo'), 'my-repo');
    await user.type(screen.getByPlaceholderText('Repository or Workspace Access Token'), 'tok-value');
    await user.type(screen.getByPlaceholderText('Per-repo webhook secret'), 'sec-value');
    await user.click(screen.getByRole('button', { name: /Add repository/i }));

    expect(await screen.findByText('duplicate row')).toBeInTheDocument();
    await waitFor(() => {
      expect(toastError).toHaveBeenCalled();
    });
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('the "Back to repositories" button navigates to /repos without submitting', async () => {
    const user = userEvent.setup();
    renderPage(<AddBitbucketRepoPage />, { route: '/repos/add/bitbucket' });

    await user.click(screen.getByRole('button', { name: /Back to repositories/i }));

    expect(navigateMock).toHaveBeenCalledWith('/repos');
    expect(api.addBitbucketRepo).not.toHaveBeenCalled();
  });
});
