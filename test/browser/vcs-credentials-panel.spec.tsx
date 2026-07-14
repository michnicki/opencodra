import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { VcsCredentialsPage } from '@client/pages/vcs-credentials';
import { api } from '@client/lib/api';
import { renderPage } from './render';
import type { VcsCredentialStatus } from '@shared/schema';

vi.mock('@client/lib/api', () => ({
  api: {
    getVcsCredentials: vi.fn(),
    storeVcsCredential: vi.fn(),
    deleteVcsCredential: vi.fn(),
  },
}));

// A sentinel secret. The redacted READ DTO deliberately carries NO token or
// webhook-secret string — this value must NEVER appear in the rendered DOM.
const SENTINEL_SECRET = 'super-secret-bearer-token-DO-NOT-RENDER';

// Redacted DTO (D-10 / T-04-01): only presence booleans, expiry, label, and the
// server-precomputed status — never the secrets themselves.
const REDACTED_CREDENTIAL: VcsCredentialStatus = {
  vcsProvider: 'bitbucket',
  workspace: 'acme',
  repoSlug: 'widgets',
  hasToken: true,
  hasWebhookSecret: true,
  tokenExpiresAt: '2099-01-01T00:00:00.000Z',
  label: 'reviewer bot',
  status: 'valid',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe('VcsCredentialsPage redaction guardrail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getVcsCredentials).mockResolvedValue({ credentials: [REDACTED_CREDENTIAL] });
  });

  it('renders identity + server status but never a secret string', async () => {
    const { container } = renderPage(<VcsCredentialsPage />);

    // Identity string (workspace/repo_slug) and the server-precomputed status label render.
    expect(await screen.findByText('acme/widgets')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    // Presence affordance shows the secret is stored WITHOUT rendering it.
    expect(screen.getByText(/Token stored/)).toBeInTheDocument();

    // The panel never renders a secret value — even a sentinel one is absent because
    // the redacted DTO carries no secret fields at all.
    expect(container.textContent).not.toContain(SENTINEL_SECRET);
    expect(container.textContent).not.toMatch(/bearer-token/i);
  });

  it('masks both secret inputs as type=password', async () => {
    renderPage(<VcsCredentialsPage />);

    // Open the add form which exposes both secret fields.
    const addButton = await screen.findByRole('button', { name: 'Add credential' });
    addButton.click();

    const tokenInput = await screen.findByPlaceholderText('Repository or Workspace Access Token');
    const secretInput = await screen.findByPlaceholderText('Per-repo webhook secret');

    await waitFor(() => {
      expect(tokenInput).toHaveAttribute('type', 'password');
      expect(secretInput).toHaveAttribute('type', 'password');
    });
  });
});
