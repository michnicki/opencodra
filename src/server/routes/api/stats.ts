import { Hono } from 'hono';
import type { AppEnv } from '@server/env';
import { getStats } from '@server/db/stats';

export function createStatsRouter() {
  const app = new Hono<AppEnv>();

  app.get('/', async (c) => {
    const stats = await getStats(c.env);
    return c.json({ stats });
  });

  return app;
}
