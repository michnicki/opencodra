import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '@server/env';
import { wantsHtml } from '@server/core/http';
import { hasValidSession, readSessionToken } from '@server/core/sessions';

export const requireSession = createMiddleware<AppEnv>(async (c, next) => {
  await readSessionToken(c);
  const valid = await hasValidSession(c);
  if (!valid) {
    if (wantsHtml(c.req.raw)) {
      return c.redirect('/login');
    }

    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  await next();
});
