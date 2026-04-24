import { Hono } from 'hono';
import type { AppEnv } from '@server/env';

export function createAuthApiRouter() {
  const app = new Hono<AppEnv>();

  app.get('/session', async (c) => {
    const sessionUser = c.get('sessionUser');
    if (!sessionUser) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    return c.json({ user: sessionUser });
  });

  return app;
}
