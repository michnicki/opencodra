import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '@server/env';
import { logger } from '@server/core/logger';

export const observability: MiddlewareHandler<AppEnv> = async (c, next) => {
  const requestId = c.req.header('x-request-id') || crypto.randomUUID();
  c.set('requestId', requestId);

  return logger.runWithContext({
    requestId,
    method: c.req.method,
    path: c.req.path,
  }, async () => {
    logger.info(`Incoming request: ${c.req.method} ${c.req.path}`);

    const start = Date.now();
    let threw = false;
    try {
      await next();
    } catch (error) {
      // If a downstream handler/middleware throws, the request still "completed" from an
      // observability standpoint. Without this the failure and its duration were never logged
      // (the completion line below was unreachable) and the error was swallowed by runWithContext.
      threw = true;
      logger.error(`Request failed: ${c.req.method} ${c.req.path}`, error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      logger.info(`Request completed: ${c.req.method} ${c.req.path}`, {
        // On the throw path the response isn't finalized yet (Hono's onError runs after this
        // middleware unwinds), so avoid reading c.res and report the eventual 500 instead.
        status: threw ? 500 : c.res.status,
        durationMs: Date.now() - start,
      });
    }
  });
};
