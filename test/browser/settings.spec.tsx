import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsPage } from '@client/pages/settings';
import { api } from '@client/lib/api';
import { renderPage } from './render';
import type { LlmProvider, ModelConfig } from '@shared/schema';
import type { ModelConfigsResponse } from '@shared/api';

vi.mock('@client/lib/api', () => ({
  api: {
    getModelConfigs: vi.fn(),
    getGlobalConfig: vi.fn(),
    getReviewSettings: vi.fn(),
    refreshModelCatalog: vi.fn(),
    updateProvider: vi.fn(),
    createProvider: vi.fn(),
    deleteProvider: vi.fn(),
    updateGlobalConfig: vi.fn(),
  },
}));

const PROVIDER: LlmProvider = {
  id: '11111111-1111-1111-1111-111111111111',
  name: 'Custom OpenAI',
  apiFormat: 'openai',
  baseUrl: 'https://api.example.com/v1',
  enabled: false,
  hasApiKey: false,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const MODEL_CONFIG: ModelConfig = {
  modelId: 'gpt-4o-mini',
  providerId: PROVIDER.id,
  providerName: PROVIDER.name,
  apiFormat: 'openai',
  modelName: 'gpt-4o-mini',
  updatedAt: new Date().toISOString(),
};

function modelConfigsResponse(overrides: Partial<ModelConfigsResponse> = {}): ModelConfigsResponse {
  return {
    providers: [PROVIDER],
    configs: [MODEL_CONFIG],
    syncErrors: [],
    ...overrides,
  };
}

describe('SettingsPage provider management', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getModelConfigs).mockResolvedValue(modelConfigsResponse());
    vi.mocked(api.refreshModelCatalog).mockResolvedValue(modelConfigsResponse());
    vi.mocked(api.getGlobalConfig).mockResolvedValue({ config: { main: null, fallbacks: [], size_overrides: [] } });
    vi.mocked(api.getReviewSettings).mockResolvedValue({ settings: { concurrencyLevel: 'medium', maxComments: 10 } });
  });

  it('renders providers and models loaded from the API', async () => {
    renderPage(<SettingsPage />);

    expect((await screen.findAllByText('Custom OpenAI')).length).toBeGreaterThan(0);
    // Proves the model catalog loaded: the provider row shows its model count.
    expect(screen.getByText('· 1 model')).toBeInTheDocument();
    expect(screen.getByText('Default models')).toBeInTheDocument();
  });

  it('edits a provider API key and saves the expected payload', async () => {
    vi.mocked(api.updateProvider).mockResolvedValue({
      provider: { ...PROVIDER, hasApiKey: true },
    });

    const user = userEvent.setup();
    renderPage(<SettingsPage />);

    await screen.findAllByText('Custom OpenAI');

    await user.click(screen.getByRole('button', { name: 'Configure' }));
    const apiKeyInput = await screen.findByPlaceholderText('sk-…');
    await user.type(apiKeyInput, 'sk-test-123');

    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(api.updateProvider).toHaveBeenCalledWith(PROVIDER.id, {
        name: 'Custom OpenAI',
        apiFormat: 'openai',
        baseUrl: 'https://api.example.com/v1',
        enabled: false,
        apiKey: 'sk-test-123',
      });
    });
  });

  it('shows an error alert when saving a provider fails', async () => {
    vi.mocked(api.updateProvider).mockRejectedValue(new Error('Provider update failed: bad credentials'));

    const user = userEvent.setup();
    renderPage(<SettingsPage />);

    await screen.findAllByText('Custom OpenAI');

    await user.click(screen.getByRole('button', { name: 'Configure' }));
    const apiKeyInput = await screen.findByPlaceholderText('sk-…');
    await user.type(apiKeyInput, 'sk-test-123');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Provider update failed: bad credentials')).toBeInTheDocument();
  });
});
