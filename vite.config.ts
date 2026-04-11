import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  root: '.',
  publicDir: false,
  resolve: {
    alias: {
      '@client': path.resolve(rootDir, 'src/client'),
      '@server': path.resolve(rootDir, 'src/server'),
      '@shared': path.resolve(rootDir, 'src/shared'),
    },
  },
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
  },
});
