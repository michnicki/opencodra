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

const databaseUrl = process.env.DATABASE_URL ?? await readDatabaseUrlFromEnvFiles();
const sql = postgres(databaseUrl, { onnotice: () => {} });

async function run() {
  try {
    const rows = await sql`SELECT repository_id, parsed_json FROM repo_configs`;
    let count = 0;
    for (const row of rows) {
      let parsed = row.parsed_json;
      if (typeof parsed === 'string') {
        parsed = JSON.parse(parsed);
      }
      if (parsed?.review?.max_files === 15) {
        parsed.review.max_files = 100;
        await sql`
          UPDATE repo_configs 
          SET parsed_json = ${JSON.stringify(parsed)}::jsonb 
          WHERE repository_id = ${row.repository_id}
        `;
        count++;
      }
    }
    console.log(`Updated ${count} repository configurations from 15 to 100.`);
  } catch (err) {
    console.error(err);
  } finally {
    await sql.end();
  }
}
run();
