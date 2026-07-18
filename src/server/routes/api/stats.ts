import { Hono } from 'hono';
import type { AppEnv } from '@server/env';
import { getStats } from '@server/db/stats';

export function createStatsRouter() {
  const app = new Hono<AppEnv>();

  app.get('/', async (c) => {
    const daysParam = c.req.query('days');
    const parsedDays = daysParam ? parseInt(daysParam, 10) : 30;
    // Coerce a non-numeric ?days= to the 30-day default and clamp to [1, 3650] (≈10y) so an
    // out-of-range, negative, or NaN value cannot drive an unbounded stats query window.
    const days = Number.isNaN(parsedDays) ? 30 : Math.min(Math.max(parsedDays, 1), 3650);
    const stats = await getStats(c.env, days);
    return c.json({ stats });
  });

  return app;
}
