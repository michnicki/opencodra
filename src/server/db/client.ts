import { neon } from '@neondatabase/serverless';
import type { AppBindings } from '@server/env';

let cachedUrl = '';
let cachedClient: ReturnType<typeof neon> | null = null;

export function getDb(env: Pick<AppBindings, 'NEON_DATABASE_URL'>) {
  if (!cachedClient || cachedUrl !== env.NEON_DATABASE_URL) {
    cachedUrl = env.NEON_DATABASE_URL;
    cachedClient = neon(env.NEON_DATABASE_URL);
  }

  return cachedClient;
}

export async function queryRows<T>(env: Pick<AppBindings, 'NEON_DATABASE_URL'>, sqlText: string, params: unknown[] = []) {
  const sql = getDb(env);
  return (await sql.query(sqlText, params)) as T[];
}
