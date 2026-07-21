import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

// Git tags are the source of truth for the displayed version: package.json's
// `version` field was inherited from the upstream project (0.9.4) and never
// bumped as tags advanced (v0.9.2 -> v1.0 -> v1.1), so it ships a stale string.
// Derive from `git describe` at build time; fall back to package.json's bare
// version only if git is unavailable (e.g. CI without a .git dir) so the build
// never breaks.
const appVersion = (() => {
  try {
    return execSync('git describe --tags --always --dirty', {
      cwd: rootDir,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim()
      // `git describe` carries the tag's leading `v` (e.g. `v1.0-176-g06db79a`);
      // strip it so the JSX literal `v` prefix isn't doubled up (vv1.0-...).
      .replace(/^v/, '');
  } catch {
    const pkg = JSON.parse(readFileSync(path.resolve(rootDir, 'package.json'), 'utf8'));
    return pkg.version as string;
  }
})();

export default defineConfig(({ mode }) => ({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  plugins: [react(), tailwindcss()],
  root: '.',
  publicDir: 'public',
  resolve: {
    alias: {
      '@client': path.resolve(rootDir, 'src/client'),
      '@server': path.resolve(rootDir, 'src/server'),
      '@shared': path.resolve(rootDir, 'src/shared'),
      '@': path.resolve(rootDir, 'src/client'),
    },
  },
  build: {
    outDir: 'dist/client',
    emptyOutDir: mode !== 'development',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('react') || id.includes('react-dom') || id.includes('react-router-dom')) {
              return 'vendor-react';
            }
            if (id.includes('recharts')) {
              return 'vendor-recharts';
            }
            if (id.includes('lucide-react')) {
              return 'vendor-lucide';
            }
            if (id.includes('motion')) {
              return 'vendor-motion';
            }
            if (id.includes('remark') || id.includes('rehype') || id.includes('micromark') || id.includes('markdown')) {
              return 'vendor-markdown';
            }
            if (id.includes('@radix-ui')) {
              return 'vendor-radix';
            }
            if (id.includes('hono') || id.includes('zod') || id.includes('jsonrepair')) {
              return 'vendor-utils';
            }
            return 'vendor';
          }
        },
      },
    },
  },
}));
