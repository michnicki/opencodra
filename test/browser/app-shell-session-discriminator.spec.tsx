import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppShell } from '@client/components/layout/app-shell';
import { api } from '@client/lib/api';
import { renderPage } from './render';
import type { AuthSessionUser } from '@shared/api';

vi.mock('@client/lib/api', () => ({
  api: {
    getSession: vi.fn(),
    logout: vi.fn(),
  },
}));

const GITHUB_USER: AuthSessionUser = {
  provider: 'github',
  githubUserId: 1,
  login: 'octocat',
  name: 'The Octocat',
  avatarUrl: 'https://avatars.githubusercontent.com/u/1',
  email: null,
  signedInAt: '2026-01-01T00:00:00.000Z',
};

const BITBUCKET_USER: AuthSessionUser = {
  provider: 'bitbucket',
  accountId: '557058:1bb1b1aa-1111-2222-3333-444455556666',
  uuid: '{11111111-2222-3333-4444-555566667777}',
  username: 'alice',
  displayName: 'Alice',
  avatarUrl: null,
  email: null,
  signedInAt: '2026-01-01T00:00:00.000Z',
};

async function openAccountMenu() {
  const user = userEvent.setup();
  // The trigger button's accessible name is derived from its visible text content
  // (account name + handle), not its `title` attribute -- query by title explicitly.
  const trigger = await screen.findByTitle(/account menu/i);
  await user.click(trigger);
  return user;
}

describe('AppShell session discriminator (D-26 client mirror / Pitfall 6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the GitHub variant chip + shows the "GitHub profile" menu item', async () => {
    vi.mocked(api.getSession).mockResolvedValue({ user: GITHUB_USER });
    renderPage(<AppShell />);

    expect(await screen.findByText('The Octocat')).toBeInTheDocument();
    expect(screen.getByText('@octocat')).toBeInTheDocument();

    await openAccountMenu();
    expect(await screen.findByRole('menuitem', { name: /GitHub profile/i })).toBeInTheDocument();
  });

  it('renders the Bitbucket variant chip + HIDES the "GitHub profile" menu item', async () => {
    vi.mocked(api.getSession).mockResolvedValue({ user: BITBUCKET_USER });
    renderPage(<AppShell />);

    expect(await screen.findByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('@alice')).toBeInTheDocument();

    await openAccountMenu();
    // Give the menu a tick to fully render before asserting absence.
    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: /Logout/i })).toBeInTheDocument();
    });
    expect(screen.queryByRole('menuitem', { name: /GitHub profile/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/github\.com/i)).not.toBeInTheDocument();
  });

  it('falls back to no account menu when there is no session', async () => {
    vi.mocked(api.getSession).mockRejectedValue(new Error('Unauthorized'));
    renderPage(<AppShell />);

    await waitFor(() => {
      expect(api.getSession).toHaveBeenCalled();
    });
    expect(screen.queryByTitle(/account menu/i)).not.toBeInTheDocument();
  });

  it('renders the GitHub avatarUrl in the chip', async () => {
    vi.mocked(api.getSession).mockResolvedValue({ user: GITHUB_USER });
    renderPage(<AppShell />);

    const trigger = await screen.findByTitle(/account menu/i);
    const avatar = trigger.querySelector(`img[src="${GITHUB_USER.avatarUrl}"]`);
    expect(avatar).not.toBeNull();
  });

  it('renders an initial-letter placeholder (no avatarUrl) for the Bitbucket variant', async () => {
    vi.mocked(api.getSession).mockResolvedValue({ user: BITBUCKET_USER });
    renderPage(<AppShell />);

    const trigger = await screen.findByTitle(/account menu/i);
    expect(trigger.querySelector('img')).toBeNull();
    expect(trigger.textContent).toContain('A');
  });
});
