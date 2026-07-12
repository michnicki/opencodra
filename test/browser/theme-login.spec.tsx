import { describe, it, expect, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoginPage } from '@client/pages/login';
import { renderPage } from './render';

describe('Theme toggle', () => {
  beforeEach(() => {
    localStorage.setItem('codra-theme', 'light');
    document.documentElement.classList.remove('dark');
    document.documentElement.setAttribute('data-theme', 'light');
  });

  it('starts in the seeded light theme', async () => {
    renderPage(<LoginPage />);

    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('toggles to dark and persists the choice in localStorage', async () => {
    const user = userEvent.setup();
    renderPage(<LoginPage />);

    await user.click(screen.getByRole('button', { name: 'Toggle theme' }));

    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem('codra-theme')).toBe('dark');
  });

  it('toggles back to light on a second click', async () => {
    const user = userEvent.setup();
    renderPage(<LoginPage />);

    const toggleButton = screen.getByRole('button', { name: 'Toggle theme' });
    await user.click(toggleButton);
    await user.click(toggleButton);

    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(localStorage.getItem('codra-theme')).toBe('light');
  });
});
