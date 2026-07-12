import type { ReactNode } from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '@client/lib/theme';

export function renderPage(ui: ReactNode, options: { route?: string } = {}) {
  const { route = '/' } = options;
  return render(
    <ThemeProvider>
      <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
    </ThemeProvider>,
  );
}
