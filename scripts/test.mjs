import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
// Resolve Vitest's CLI relative to the actual install location (`./package.json` is the only
// reliably-exported subpath — `vitest/vitest.mjs` is blocked by the package's "exports" map).
// This survives hoisting/monorepo layouts and doesn't assume the process cwd is the repo root.
const vitestCli = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs');

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFiles = ['.env.test', '.env.local', '.env', '.dev.vars', '.env.test.example'];

function parseEnvValue(value) {
  let trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    trimmed = trimmed.slice(1, -1);
  }

  return trimmed.replace(/\\n/g, '\n');
}

function usableEnvValue(value) {
  return value && value !== 'undefined' && value !== 'null' ? value : null;
}

function loadEnvFiles() {
  for (const file of envFiles) {
    try {
      const content = readFileSync(path.join(rootDir, file), 'utf8');
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;

        const separatorIndex = trimmed.indexOf('=');
        if (separatorIndex === -1) continue;

        const key = trimmed.slice(0, separatorIndex).trim();
        if (process.env[key] === undefined) {
          process.env[key] = parseEnvValue(trimmed.slice(separatorIndex + 1));
        }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

function run(command, args) {
  // The full environment is forwarded intentionally: `migrate.mjs` needs DATABASE_URL and the
  // Vitest child needs TEST_DATABASE_URL plus every other secret the test setup (`test/setup.ts`,
  // `test/helpers.ts`) loads to exercise crypto/OAuth/webhook paths. Stripping "sensitive" vars
  // here would break the suite. This runner is a thin dev/CI wrapper that does not itself log the
  // environment; secret redaction for anything the code paths *do* log is handled by
  // `core/logger.ts`'s `redact()`. Do not swap this for a hand-curated allow-list.
  const result = spawnSync(command, args, {
    cwd: rootDir,
    env: process.env,
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

loadEnvFiles();

if (!usableEnvValue(process.env.TEST_DATABASE_URL)) {
  console.error([
    'TEST_DATABASE_URL is required to run the full test suite.',
    'Copy .env.test.example to .env.test and point TEST_DATABASE_URL at a disposable Postgres database.',
  ].join('\n'));
  process.exit(1);
}

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

run(process.execPath, ['scripts/migrate.mjs']);
run(process.execPath, [vitestCli, 'run', '--project', 'node']);
