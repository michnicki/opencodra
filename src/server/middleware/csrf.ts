import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '@server/env';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const REQUESTED_WITH = 'XMLHttpRequest';

export const requireCsrfHeader = createMiddleware<AppEnv>(async (c, next) => {
  if (SAFE_METHODS.has(c.req.method.toUpperCase())) {
    await next();
    return;
  }

  if (c.req.header('x-requested-with') !== REQUESTED_WITH) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  await next();
});
