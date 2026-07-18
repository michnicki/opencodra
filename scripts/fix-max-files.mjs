import postgres from 'postgres';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function readDatabaseUrlFromEnvFiles() {
  const envFiles = ['.dev.vars', '.env.local', '.env'];
  for (const file of envFiles) {
    try {
      const content = await readFile(path.join(rootDir, file), 'utf8');
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.startsWith('DATABASE_URL=')) {
          let val = trimmed.slice(13).trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            return val.slice(1, -1);
          }
          return val;
        }
      }
    } catch {}
  }
  return null;
}

// This is a destructive maintenance script: it rewrites `review.max_files` from 15 to 100
// across every matching repo config on whatever database DATABASE_URL points at. To avoid an
// accidental production mutation, it runs in DRY-RUN mode by default (SELECT + row-count
// preview) and only performs the UPDATE when `--apply` is passed explicitly.
const APPLY = process.argv.includes('--apply');

const databaseUrl = process.env.DATABASE_URL ?? (await readDatabaseUrlFromEnvFiles());

// Guard: construct the client only after we have a URL. `postgres(undefined)` can throw during
// construction before the try/catch in run() is entered, leaking an unhandled rejection.
if (!databaseUrl) {
  console.error(
    [
      'DATABASE_URL is required to run this maintenance script.',
      'Set DATABASE_URL in your shell/CI environment or add it to .dev.vars, .env.local, or .env.',
    ].join('\n'),
  );
  process.exit(1);
}

const sql = postgres(databaseUrl, { onnotice: () => {} });

async function run() {
  try {
    const matches = await sql`
      SELECT count(*)::int AS count
      FROM repo_configs
      WHERE parsed_json#>>'{review,max_files}' = '15'
    `;
    const count = matches[0]?.count ?? 0;

    if (!APPLY) {
      console.log(
        [
          `[dry-run] ${count} repository configuration(s) currently have review.max_files = 15.`,
          count > 0
            ? 'Re-run with `--apply` to update them from 15 to 100.'
            : 'Nothing to update.',
          'No changes were made.',
        ].join('\n'),
      );
      return;
    }

    const result = await sql`
      UPDATE repo_configs
      SET parsed_json = jsonb_set(parsed_json, '{review,max_files}', '100'::jsonb)
      WHERE parsed_json#>>'{review,max_files}' = '15'
    `;
    console.log(`Updated ${result.count} repository configurations from 15 to 100.`);
  } catch (err) {
    // Preserve the failure so CI/cron sees a non-zero exit; a swallowed error must not look
    // like a successful run.
    console.error(err);
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}

run();
