import { createApp } from '@server/app';
import { runReviewJob } from '@server/core/review';
import { queryRows, runWithDb } from '@server/db/client';
import { findExistingJobForHead } from '@server/db/jobs';
import {
  createMockPRWebhook,
  createTestEnv,
  generateMockDiff,
  hasConfiguredTestDatabaseUrl,
  MockQueue,
  seedDefaultModelStrategy,
  seedInstallationToken,
  signWebhookPayload,
} from './helpers';
import { installGitHubFetchMock } from './github-fetch-mock';

const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;
const PIPELINE_TEST_TIMEOUT_MS = 60_000;
const MODEL_ID = 'test-review-model';
const INSTALLATION_ID = 987654;

const AI_WITH_ISSUE = JSON.stringify({
  findings: [
    {
      title: 'Possible null dereference',
      body: 'This value could be null at runtime and is not checked before use.',
      priority: 0,
      code_location: { line: 3 },
    },
  ],
  overall_explanation: 'Found a null-safety issue.',
  overall_correctness: 'patch is incorrect',
  overall_confidence_score: 0.9,
});

const AI_CLEAN = JSON.stringify({
  findings: [],
  overall_explanation: 'No issues found.',
  overall_correctness: 'patch is correct',
  overall_confidence_score: 0.95,
});

function fakeAiBinding(responseText: string) {
  return {
    async run() {
      return { response: responseText, usage: { prompt_tokens: 120, completion_tokens: 40 } };
    },
  };
}

function buildFixture(repo: string, prNumber: number) {
  const headSha = 'a'.repeat(40);
  const baseSha = 'b'.repeat(40);
  const diff = generateMockDiff([{ path: 'src/app.ts', content: 'line1\nline2\nline3\nline4\nline5' }]);

  const pull = {
    number: prNumber,
    title: 'Add null check',
    body: 'This PR adds a null check.',
    draft: false,
    head: { sha: headSha, ref: 'feature' },
    base: { sha: baseSha, ref: 'main' },
    user: { login: 'octocat' },
  };

  const webhookPayload = createMockPRWebhook({
    action: 'opened',
    installation: { id: INSTALLATION_ID },
    repository: { name: repo, owner: { login: 'test-owner' } },
    pull_request: pull,
  });

  return { headSha, baseSha, diff, pull, webhookPayload };
}

async function postWebhook(app: ReturnType<typeof createApp>, env: ReturnType<typeof createTestEnv>, payload: unknown) {
  const body = JSON.stringify(payload);
  const signature = await signWebhookPayload(env.GITHUB_APP_WEBHOOK_SECRET, body);

  return app.request(
    'http://codra.test/webhook',
    {
      method: 'POST',
      headers: {
        'x-github-event': 'pull_request',
        'x-github-delivery': `delivery-${Date.now()}-${Math.random()}`,
        'x-hub-signature-256': signature,
        'content-type': 'application/json',
      },
      body,
    },
    env,
  );
}

// The review pipeline now runs through Cloudflare Workflows in production: runReviewJob no longer
// re-enqueues the next phase onto REVIEW_QUEUE itself, it returns `{action:'next_phase', phase,
// delaySeconds}` and the caller (normally ReviewWorkflow's step loop) decides whether to continue.
// This mirrors the `runAndDrain` helper in test/review-flow.spec.ts: drive runReviewJob directly,
// chasing the returned phase, and backdate last_queue_message_at so the next claim doesn't read as
// 'busy' (claimJobLease treats a future last_queue_message_at as a fresh lease held elsewhere).
async function runAndDrain(env: ReturnType<typeof createTestEnv>, message: Parameters<typeof runReviewJob>[1]) {
  await runWithDb(env, async () => {
    let currentMessage: typeof message | null = message;
    let retries = 0;
    const MAX_RETRIES = 5;

    while (currentMessage) {
      const result = await runReviewJob(env, currentMessage);
      if (result.action === 'next_phase') {
        currentMessage = { ...currentMessage, phase: result.phase };
        retries = 0;
        const jobId = currentMessage.jobId;
        if (jobId) {
          await queryRows(env, `UPDATE jobs SET last_queue_message_at = now() - interval '5 seconds' WHERE id = $1`, [jobId]);
        }
      } else if (result.action === 'retry') {
        if (++retries > MAX_RETRIES) throw new Error('Max retries exceeded');
        break;
      } else {
        currentMessage = null;
      }
    }
  });
}

// runReviewJob throttles admission of a fresh 'queued' job once REVIEW_CONCURRENCY_LIMITS[level]
// other jobs are 'running' (globally, with no per-installation/repo scoping). Other spec files in
// this shared-DB suite intentionally leave jobs 'running' to exercise that same admission-control
// path, which would otherwise make this spec's outcome depend on file execution order. Since
// fileParallelism is false, nothing else touches the DB concurrently with this file, so it's safe
// to clear stray 'running' rows before each test.
async function clearStrayRunningJobs(env: ReturnType<typeof createTestEnv>) {
  await queryRows(env, `UPDATE jobs SET status = 'failed', error_msg = 'stray running job cleared before pipeline test' WHERE status = 'running'`);
}

dbDescribe('PR review pipeline (real GitHubClient + real ModelService)', () => {
  const app = createApp();

  it('posts a COMMENT review with correctly positioned inline comments and manages labels', async () => {
    const repo = `pipeline-repo-${Date.now()}-comment`;
    const env = createTestEnv({ AI: fakeAiBinding(AI_WITH_ISSUE) as any });
    await seedInstallationToken(env, String(INSTALLATION_ID));
    await seedDefaultModelStrategy(env, MODEL_ID);
    await clearStrayRunningJobs(env);

    const { headSha, diff, pull, webhookPayload } = buildFixture(repo, 11);
    const { calls, restore } = installGitHubFetchMock({
      owner: 'test-owner',
      repo,
      prNumber: 11,
      pull,
      diff,
    });

    try {
      const response = await postWebhook(app, env, webhookPayload);
      expect(response.status).toBe(202);
      const json = await response.json() as { message: string };
      expect(json.message).toBe('queued');
      expect((env.REVIEW_QUEUE as unknown as MockQueue).sent).toHaveLength(1);

      const initialMessage = (env.REVIEW_QUEUE as unknown as MockQueue).sent[0];
      await runAndDrain(env, initialMessage);

      const finalJob = await findExistingJobForHead(env, {
        owner: 'test-owner',
        repo,
        prNumber: 11,
        commitSha: headSha,
        trigger: 'auto',
      });
      expect(finalJob?.status).toBe('done');

      const checkRunCreate = calls.find((c) => c.method === 'POST' && c.path.endsWith('/check-runs'));
      expect(checkRunCreate?.body).toMatchObject({ name: 'OpenCodra', head_sha: headSha });

      const checkRunUpdates = calls.filter((c) => c.method === 'PATCH' && /\/check-runs\/\d+$/.test(c.path));
      expect(checkRunUpdates.length).toBeGreaterThan(0);
      expect(checkRunUpdates.at(-1)?.body).toMatchObject({ status: 'completed' });

      const reviewCall = calls.find((c) => c.method === 'POST' && c.path.endsWith('/reviews'));
      expect(reviewCall?.body).toMatchObject({
        commit_id: headSha,
        event: 'COMMENT',
      });
      expect(reviewCall?.body.comments).toEqual([
        expect.objectContaining({
          path: 'src/app.ts',
          position: 3,
        }),
      ]);
      expect(reviewCall?.body.comments[0].body).toContain('Possible null dereference');

      const labelLookup = calls.find((c) => c.method === 'GET' && c.path.includes('/labels/'));
      expect(labelLookup).toBeDefined();
      const labelCreate = calls.find((c) => c.method === 'POST' && c.path.endsWith('/labels') && !c.path.includes('/issues/'));
      expect(labelCreate?.body).toMatchObject({ name: 'review: needs-attention' });
      const issueLabelAdd = calls.find((c) => c.method === 'POST' && /\/issues\/\d+\/labels$/.test(c.path));
      expect(issueLabelAdd?.body).toMatchObject({ labels: ['review: needs-attention'] });
    } finally {
      restore();
    }
  }, PIPELINE_TEST_TIMEOUT_MS);

  it('approves a clean PR with no inline comments', async () => {
    const repo = `pipeline-repo-${Date.now()}-approve`;
    const env = createTestEnv({ AI: fakeAiBinding(AI_CLEAN) as any });
    await seedInstallationToken(env, String(INSTALLATION_ID));
    await seedDefaultModelStrategy(env, MODEL_ID);
    await clearStrayRunningJobs(env);

    const { headSha, diff, pull, webhookPayload } = buildFixture(repo, 22);
    const { calls, restore } = installGitHubFetchMock({
      owner: 'test-owner',
      repo,
      prNumber: 22,
      pull,
      diff,
    });

    try {
      const response = await postWebhook(app, env, webhookPayload);
      expect(response.status).toBe(202);

      const initialMessage = (env.REVIEW_QUEUE as unknown as MockQueue).sent[0];
      await runAndDrain(env, initialMessage);

      const finalJob = await findExistingJobForHead(env, {
        owner: 'test-owner',
        repo,
        prNumber: 22,
        commitSha: headSha,
        trigger: 'auto',
      });
      expect(finalJob?.status).toBe('done');
      expect(finalJob?.verdict).toBe('approve');

      const reviewCall = calls.find((c) => c.method === 'POST' && c.path.endsWith('/reviews'));
      expect(reviewCall?.body).toMatchObject({ event: 'APPROVE', comments: [] });

      const checkRunUpdates = calls.filter((c) => c.method === 'PATCH' && /\/check-runs\/\d+$/.test(c.path));
      expect(checkRunUpdates.at(-1)?.body).toMatchObject({ status: 'completed', conclusion: 'success' });

      const labelCreate = calls.find((c) => c.method === 'POST' && c.path.endsWith('/labels') && !c.path.includes('/issues/'));
      expect(labelCreate?.body).toMatchObject({ name: 'review: approved' });
    } finally {
      restore();
    }
  }, PIPELINE_TEST_TIMEOUT_MS);

  it('retries review creation without inline comments when GitHub returns 422', async () => {
    const repo = `pipeline-repo-${Date.now()}-422`;
    const env = createTestEnv({ AI: fakeAiBinding(AI_WITH_ISSUE) as any });
    await seedInstallationToken(env, String(INSTALLATION_ID));
    await seedDefaultModelStrategy(env, MODEL_ID);
    await clearStrayRunningJobs(env);

    const { headSha, diff, pull, webhookPayload } = buildFixture(repo, 33);
    const { calls, restore } = installGitHubFetchMock({
      owner: 'test-owner',
      repo,
      prNumber: 33,
      pull,
      diff,
      reviewResponses: [{ status: 422 }, { status: 200, id: 7001 }],
    });

    try {
      const response = await postWebhook(app, env, webhookPayload);
      expect(response.status).toBe(202);

      const initialMessage = (env.REVIEW_QUEUE as unknown as MockQueue).sent[0];
      await runAndDrain(env, initialMessage);

      const finalJob = await findExistingJobForHead(env, {
        owner: 'test-owner',
        repo,
        prNumber: 33,
        commitSha: headSha,
        trigger: 'auto',
      });
      expect(finalJob?.status).toBe('done');

      const reviewCalls = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/reviews'));
      expect(reviewCalls).toHaveLength(2);
      expect(reviewCalls[0].body.comments.length).toBeGreaterThan(0);
      expect(reviewCalls[1].body.comments).toEqual([]);
    } finally {
      restore();
    }
  }, PIPELINE_TEST_TIMEOUT_MS);
});
