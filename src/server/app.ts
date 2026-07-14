import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '@server/env';
import { requireSession } from '@server/middleware/auth';
import { requireCsrfHeader } from '@server/middleware/csrf';
import { observability } from '@server/middleware/observability';
import { createAuthRouter } from '@server/routes/auth';
import { createAuthBitbucketRouter } from '@server/routes/auth-bitbucket';
import { createWebhookRouter } from '@server/routes/webhook';
import { createBitbucketWebhookRouter } from '@server/routes/webhook-bitbucket';
import { createAuthApiRouter } from '@server/routes/api/auth';
import { createJobsRouter } from '@server/routes/api/jobs';
import { createReposRouter } from '@server/routes/api/repos';
import { createStatsRouter } from '@server/routes/api/stats';
import { createModelsRouter } from '@server/routes/api/models';
import { createSettingsRouter } from '@server/routes/api/settings';
import { createVcsCredentialsRouter } from '@server/routes/api/vcs-credentials';

async function serveIndex(c: Context<AppEnv>) {
  return c.env.ASSETS.fetch(new URL('/index.html', c.req.url));
}

export function createApp() {
  const app = new Hono<AppEnv>();

  app.use('*', observability);
  app.use('/auth/logout', requireSession);
  app.use('/auth/logout', requireCsrfHeader);

  app.route('/auth', createAuthRouter());
  app.route('/auth', createAuthBitbucketRouter());
  app.route('/webhook', createWebhookRouter());
  app.route('/webhook/bitbucket', createBitbucketWebhookRouter());

  app.use('/api/*', requireSession);
  app.use('/api/*', requireCsrfHeader);

  app.route('/api/auth', createAuthApiRouter());
  app.route('/api/jobs', createJobsRouter());
  app.route('/api/repos', createReposRouter());
  app.route('/api/stats', createStatsRouter());
  app.route('/api/models', createModelsRouter());
  app.route('/api/settings', createSettingsRouter());
  app.route('/api/vcs-credentials', createVcsCredentialsRouter());

  app.get('/login', serveIndex);
  app.get('/', serveIndex); // Unauthenticated landing page
  app.get('/dashboard', requireSession, serveIndex);
  app.get('/jobs', requireSession, serveIndex);
  app.get('/jobs/*', requireSession, serveIndex);
  app.get('/repos', requireSession, serveIndex);
  app.get('/repos/*', requireSession, serveIndex);
  app.get('/stats', requireSession, serveIndex);
  app.get('/health', requireSession, serveIndex);
  app.get('/settings', requireSession, serveIndex);
  app.get('/credentials', requireSession, serveIndex);

  return app;
}
