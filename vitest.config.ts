import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { playwright } from '@vitest/browser-playwright';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@server': resolve(__dirname, './src/server'),
      '@client': resolve(__dirname, './src/client'),
      '@shared': resolve(__dirname, './src/shared'),
      '@': resolve(__dirname, './src/client'),
      'cloudflare:workers': resolve(__dirname, './test/mocks/cloudflare-workers.ts'),
    },
  },
  test: {
    globals: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['test/**/*.spec.ts'],
          exclude: ['test/browser/**'],
          setupFiles: ['./test/setup.ts'],
          fileParallelism: false,
        },
      },
      {
        extends: true,
        test: {
          name: 'browser',
          include: ['test/browser/**/*.spec.tsx'],
          setupFiles: ['./test/browser/setup.ts'],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
});
