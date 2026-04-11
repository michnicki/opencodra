import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '@server/env';
import { requireSession } from '@server/middleware/auth';
import { createAuthRouter } from '@server/routes/auth';
import { createWebhookRouter } from '@server/routes/webhook';
import { createJobsRouter } from '@server/routes/api/jobs';
import { createReposRouter } from '@server/routes/api/repos';
import { createStatsRouter } from '@server/routes/api/stats';

async function serveIndex(c: Context<AppEnv>) {
  return c.env.ASSETS.fetch(new URL('/index.html', c.req.url));
}

export function createApp() {
  const app = new Hono<AppEnv>();

  app.route('/auth', createAuthRouter());
  app.route('/webhook', createWebhookRouter());

  app.use('/api/*', requireSession);
  app.use('/auth/logout', requireSession);

  app.route('/api/jobs', createJobsRouter());
  app.route('/api/repos', createReposRouter());
  app.route('/api/stats', createStatsRouter());

  app.get('/login', serveIndex);
  app.get('/', requireSession, serveIndex);
  app.get('/jobs', requireSession, serveIndex);
  app.get('/jobs/*', requireSession, serveIndex);
  app.get('/repos', requireSession, serveIndex);
  app.get('/stats', requireSession, serveIndex);

  return app;
}
