import { Hono } from 'hono';
import type { AppEnv } from '@server/env';
import { getRepoConfigRecord, listRepoConfigs } from '@server/db/repo-configs';
import { jsonError } from '@server/core/http';

export function createReposRouter() {
  const app = new Hono<AppEnv>();

  app.get('/', async (c) => {
    const repos = await listRepoConfigs(c.env);
    return c.json({ repos });
  });

  app.get('/:owner/:repo/config', async (c) => {
    const repo = await getRepoConfigRecord(c.env, c.req.param('owner'), c.req.param('repo'));
    if (!repo) {
      return jsonError('Repository config not found.', 404);
    }

    return c.json({ repo });
  });

  return app;
}
