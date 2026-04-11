import { Hono } from 'hono';
import { defaultRepoConfig, repoConfigSchema } from '@shared/schema';
import type { AppEnv } from '@server/env';
import { getJobDetail, getJobForProcessing, insertJob, listJobs } from '@server/db/jobs';
import { jsonError } from '@server/core/http';

export function createJobsRouter() {
  const app = new Hono<AppEnv>();

  app.get('/', async (c) => {
    const jobs = await listJobs(c.env);
    return c.json({ jobs });
  });

  app.get('/:id', async (c) => {
    const job = await getJobDetail(c.env, c.req.param('id'));
    if (!job) {
      return jsonError('Job not found.', 404);
    }

    return c.json({ job });
  });

  app.post('/:id/retry', async (c) => {
    const source = await getJobForProcessing(c.env, c.req.param('id'));
    if (!source) {
      return jsonError('Job not found.', 404);
    }

    const job = await insertJob(c.env, {
      installationId: source.installation_id,
      owner: source.owner,
      repo: source.repo,
      prNumber: source.pr_number,
      prTitle: source.pr_title,
      prAuthor: source.pr_author,
      commitSha: source.commit_sha,
      baseSha: source.base_sha,
      trigger: 'retry',
      headRef: source.head_ref,
      baseRef: source.base_ref,
      configSnapshot: repoConfigSchema.parse(source.config_snapshot ?? defaultRepoConfig),
      retryOfJobId: source.id,
    });

    await c.env.REVIEW_QUEUE.send({
      jobId: job.id,
      deliveryId: crypto.randomUUID(),
      installationId: source.installation_id,
      owner: source.owner,
      repo: source.repo,
      prNumber: source.pr_number,
      commitSha: source.commit_sha,
      trigger: 'retry',
    });

    return c.json({ job }, 202);
  });

  return app;
}
