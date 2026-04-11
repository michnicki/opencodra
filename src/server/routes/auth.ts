import { Hono } from 'hono';
import type { AppEnv } from '@server/env';
import { createSession, destroySession, verifyDashboardPassword } from '@server/core/sessions';
import { jsonError } from '@server/core/http';

export function createAuthRouter() {
  const app = new Hono<AppEnv>();

  app.post('/login', async (c) => {
    const body = await c.req.json<{ password?: string }>().catch(() => null);
    const password = body?.password?.trim() ?? '';
    if (!password) {
      return jsonError('Password is required.', 400);
    }

    const matches = await verifyDashboardPassword(c.env.DASHBOARD_PASSWORD, password);
    if (!matches) {
      return jsonError('Invalid password.', 401);
    }

    await createSession(c);
    return c.json({ ok: true });
  });

  app.post('/logout', async (c) => {
    await destroySession(c);
    return c.json({ ok: true });
  });

  return app;
}
