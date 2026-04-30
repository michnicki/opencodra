import { Hono } from 'hono';
import type { AppEnv } from '@server/env';
import { getRepoConfigRecord, listRepoConfigs, upsertRepoConfig, syncRepoConfig, updateRepoConfigEnabled } from '@server/db/repo-configs';
import { jsonError } from '@server/core/http';
import { GitHubClient, type GitHubInstallation, type GitHubRepository } from '@server/core/github';
import { invalidateRepoConfigCache } from '@server/core/config';

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
) {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function createReposRouter() {
  const app = new Hono<AppEnv>();

  app.get('/', async (c) => {
    const repos = await listRepoConfigs(c.env);
    return c.json({ repos });
  });

  app.post('/sync', async (c) => {
    try {
      const installations = await GitHubClient.listInstallations(c.env);
      const synced: string[] = [];

      for (const inst of installations) {
        const github = new GitHubClient(c.env, String(inst.id));
        const repos: GitHubRepository[] = await github.listRepositories();

        const results = await mapWithConcurrency(
          repos,
          5,
          async (repo: GitHubRepository) => {
            try {
              await syncRepoConfig(c.env, {
                installationId: String(inst.id),
                owner: repo.owner.login,
                repo: repo.name,
              });
              return `${repo.owner.login}/${repo.name}`;
            } catch (repoError) {
              console.error(`Failed to sync ${repo.owner.login}/${repo.name}:`, repoError);
              return null;
            }
          },
        );

        for (const res of results) {
          if (res) synced.push(res);
        }
      }

      return c.json({ ok: true, synced });
    } catch (error) {
      console.error('Manual sync failed:', error);
      return jsonError(`Sync failed: ${error instanceof Error ? error.message : String(error)}`, 500);
    }
  });

  app.get('/:owner/:repo/config', async (c) => {
    const repo = await getRepoConfigRecord(c.env, c.req.param('owner'), c.req.param('repo'));
    if (!repo) {
      return jsonError('Repository config not found.', 404);
    }

    return c.json({ repo });
  });
  
  app.patch('/:owner/:repo/config', async (c) => {
    const { owner, repo } = c.req.param();
    const body = await c.req.json();
    const existing = await getRepoConfigRecord(c.env, owner, repo);
    
    if (!existing) {
      return jsonError('Repository config not found.', 404);
    }
    
    const hasModelPatch = Object.prototype.hasOwnProperty.call(body, 'model');

    if (!hasModelPatch && Object.prototype.hasOwnProperty.call(body, 'enabled')) {
      await updateRepoConfigEnabled(c.env, {
        owner,
        repo,
        enabled: Boolean(body.enabled),
      });
      await invalidateRepoConfigCache(c.env, owner, repo);
      return c.json({ ok: true });
    }

    // Separate enabled from model config
    const { enabled, ...modelConfig } = body;
    
    const updatedParsedJson = {
      ...existing.parsedJson,
      ...modelConfig,
    };
    
    await upsertRepoConfig(c.env, {
      installationId: existing.installationId,
      owner,
      repo,
      parsedJson: updatedParsedJson,
      enabled: enabled !== undefined ? Boolean(enabled) : undefined,
    });
    await invalidateRepoConfigCache(c.env, owner, repo);
    
    return c.json({ ok: true });
  });

  return app;
}
