// Unit tests for the provider-agnostic webhook ingest helper (Phase 3, Plan 1; extended in 05-04).
//
// These tests drive `ingestReviewWebhookEvent` directly with a hand-built `ReviewRequest`
// fixture -- no GitHub payload, no HTTP layer, no `extractReviewRequest` call. That is the
// point: this helper is provider-agnostic (criterion 2), and Phase 5 adds a second
// (Bitbucket) caller. `test/webhook-handling.spec.ts` remains the byte-identical HTTP-level
// regression gate for the GitHub route; this file proves the helper's contract in isolation.

import { vi } from 'vitest';
import { ingestReviewWebhookEvent } from '@server/core/webhook-ingest';
import { createTestEnv, hasConfiguredTestDatabaseUrl } from './helpers';
import { insertJob, getJobForProcessing } from '@server/db/jobs';
import { defaultRepoConfig } from '@shared/schema';
import type { ReviewRequest } from '@server/core/review';

const sha = (char: string) => char.repeat(40);

const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;

function buildReviewRequest(overrides: Partial<ReviewRequest> = {}): ReviewRequest {
  return {
    installationId: '123',
    owner: `owner-${Date.now()}`,
    repo: `repo-${Date.now()}`,
    prNumber: 1,
    prTitle: 'Test PR',
    prAuthor: 'author',
    commitSha: sha('1'),
    baseSha: sha('2'),
    headRef: 'feature',
    baseRef: 'main',
    trigger: 'auto',
    ...overrides,
  };
}

dbDescribe('ingestReviewWebhookEvent (webhook-ingest helper)', () => {
  const env = createTestEnv();

  // MockQueue.sent accumulates across calls and is never auto-cleared (REVIEW finding 2) --
  // reset it here, matching test/webhook-handling.spec.ts:21's isolation pattern. Every test
  // below also uses a unique owner/repo/deliveryId so DB rows never collide across tests.
  beforeEach(() => {
    (env.REVIEW_QUEUE as any).sent.length = 0;
  });

  it('Test 1: concrete-job path queues a new job when nothing matches yet', async () => {
    const owner = `owner-t1-${Date.now()}`;
    const repo = `repo-t1-${Date.now()}`;
    const reviewRequest = buildReviewRequest({ owner, repo });

    const result = await ingestReviewWebhookEvent(env, {
      reviewRequest,
      configSnapshot: defaultRepoConfig,
      deliveryId: `delivery-t1-${Date.now()}`,
      requestId: 'req-t1',
      eventName: 'pull_request',
    });

    expect(result.outcome).toBe('queued');
    if (result.outcome === 'queued') {
      expect(result.job.status).toBe('queued');
    }

    const sent = (env.REVIEW_QUEUE as any).sent;
    expect(sent).toHaveLength(1);
    // D-02 byte-identity guarantee: no explicit `provider` was passed, so the key must be
    // entirely absent from the sent message, not merely `undefined`-valued.
    expect(Object.keys(sent[0])).not.toContain('provider');
  });

  it('Test 2: duplicate path returns the existing job and does not enqueue again', async () => {
    const owner = `owner-t2-${Date.now()}`;
    const repo = `repo-t2-${Date.now()}`;
    const reviewRequest = buildReviewRequest({ owner, repo });

    const first = await ingestReviewWebhookEvent(env, {
      reviewRequest,
      configSnapshot: defaultRepoConfig,
      deliveryId: `delivery-t2-a-${Date.now()}`,
      requestId: 'req-t2-a',
      eventName: 'pull_request',
    });
    expect(first.outcome).toBe('queued');

    const sentCountAfterFirst = (env.REVIEW_QUEUE as any).sent.length;

    const second = await ingestReviewWebhookEvent(env, {
      reviewRequest,
      configSnapshot: defaultRepoConfig,
      deliveryId: `delivery-t2-b-${Date.now()}`,
      requestId: 'req-t2-b',
      eventName: 'pull_request',
    });

    expect(second.outcome).toBe('duplicate');
    if (second.outcome === 'duplicate' && first.outcome === 'queued') {
      expect(second.job.id).toBe(first.job.id);
    }

    expect((env.REVIEW_QUEUE as any).sent).toHaveLength(sentCountAfterFirst);
  });

  it('Test 3: null reviewRequest falls back to a queued_event result', async () => {
    const deliveryId = `delivery-t3-${Date.now()}`;

    const result = await ingestReviewWebhookEvent(env, {
      reviewRequest: null,
      configSnapshot: defaultRepoConfig,
      deliveryId,
      requestId: 'req-t3',
      eventName: 'issue_comment',
    });

    expect(result).toEqual({ outcome: 'queued_event' });

    const sent = (env.REVIEW_QUEUE as any).sent;
    expect(sent).toHaveLength(1);
    expect(sent[0].eventName).toBe('issue_comment');
    expect(sent[0].job).toBeUndefined();
    expect(sent[0].payload).toBeUndefined();
    expect(Object.keys(sent[0])).not.toContain('provider');
  });

  it('Test 4: explicit provider passthrough on the null-fallback (event-only) path', async () => {
    // 05-04 widening: this test exercises the null-fallback path with provider: 'bitbucket'
    // explicit. The Phase-3 deferred-item test now passes because the helper attaches
    // provider onto the queue message -- the `findExistingJobForHead` / `supersedeOlderJobs`
    // path is also provider-aware (Test 6 + Test 7 below cover the concrete-job path).
    const deliveryId = `delivery-t4-${Date.now()}`;

    const result = await ingestReviewWebhookEvent(env, {
      reviewRequest: null,
      configSnapshot: defaultRepoConfig,
      deliveryId,
      requestId: 'req-t4',
      eventName: 'issue_comment',
      provider: 'bitbucket',
    });

    expect(result).toEqual({ outcome: 'queued_event' });

    const sent = (env.REVIEW_QUEUE as any).sent;
    expect(sent).toHaveLength(1);
    expect(sent[0].provider).toBe('bitbucket');
  });

  it('Test 5: a newer commit supersedes an older in-flight job through the helper (REVIEW finding 1)', async () => {
    const owner = `owner-t5-${Date.now()}`;
    const repo = `repo-t5-${Date.now()}`;
    const installationId = '456';
    const prNumber = 55;

    const olderJob = await insertJob(env, {
      installationId,
      owner,
      repo,
      prNumber,
      prTitle: 'Older',
      prAuthor: 'author',
      commitSha: sha('a'),
      baseSha: sha('c'),
      trigger: 'auto',
      headRef: 'feature',
      baseRef: 'main',
      configSnapshot: defaultRepoConfig,
    });

    const reviewRequest = buildReviewRequest({
      owner,
      repo,
      installationId,
      prNumber,
      commitSha: sha('b'),
      baseSha: sha('c'),
    });

    const result = await ingestReviewWebhookEvent(env, {
      reviewRequest,
      configSnapshot: defaultRepoConfig,
      deliveryId: `delivery-t5-${Date.now()}`,
      requestId: 'req-t5',
      eventName: 'pull_request',
    });

    expect(result.outcome).toBe('queued');
    if (result.outcome === 'queued') {
      expect(result.job.id).not.toBe(olderJob.id);
      expect(result.job.status).toBe('queued');
    }

    const olderAfter = await getJobForProcessing(env, olderJob.id);
    expect(olderAfter?.status).toBe('superseded');
  });
});

// ---------------------------------------------------------------------------
// 05-04 widening: the Bitbucket concrete-job path (Phase-3 deferred-item closure).
// Spy on @server/db/jobs to assert the vcsProvider threads through findExistingJobForHead +
// supersedeOlderJobs. Tests 1-5 above are UNCHANGED -- GitHub path byte-identical (NREG-02).
// ---------------------------------------------------------------------------
dbDescribe('ingestReviewWebhookEvent (Bitbucket concrete-job path - 05-04 widening)', () => {
  const env = createTestEnv();

  // vi.mock is hoisted to the top of the file by Vitest, so the factory must use vi.hoisted
  // to see the spy references. Mirrors the test/review-resilience.spec.ts:16-20 pattern.
  const { findExistingJobForHeadSpy, supersedeOlderJobsSpy } = vi.hoisted(() => ({
    findExistingJobForHeadSpy: vi.fn(),
    supersedeOlderJobsSpy: vi.fn(),
  }));

  vi.mock('@server/db/jobs', async (importOriginal) => {
    const actual = await importOriginal() as any;
    return {
      ...actual,
      findExistingJobForHead: (...args: any[]) => {
        findExistingJobForHeadSpy(...args);
        return actual.findExistingJobForHead(...args);
      },
      supersedeOlderJobs: (...args: any[]) => {
        supersedeOlderJobsSpy(...args);
        return actual.supersedeOlderJobs(...args);
      },
    };
  });

  beforeEach(() => {
    (env.REVIEW_QUEUE as any).sent.length = 0;
    findExistingJobForHeadSpy.mockClear();
    supersedeOlderJobsSpy.mockClear();
  });

  it('Test 6 (Bitbucket concrete-job path): threads provider:bitbucket through findExistingJobForHead + supersedeOlderJobs', async () => {
    const owner = `owner-bb-c-${Date.now()}`;
    const repo = `repo-bb-c-${Date.now()}`;
    const reviewRequest = buildReviewRequest({
      owner,
      repo,
      // Bitbucket has no installation_id; the route passes '' (mirrors the Task 2 route
      // construction site which uses an empty-string placeholder).
      installationId: '',
      commitSha: sha('7'),
      baseSha: sha('8'),
      repositoryVcsProvider: 'bitbucket',
      repositoryWorkspace: 'ws-bitbucket',
    });

    const result = await ingestReviewWebhookEvent(env, {
      reviewRequest,
      configSnapshot: defaultRepoConfig,
      deliveryId: `delivery-bb-c-${Date.now()}`,
      requestId: 'req-bb-c',
      eventName: 'pullrequest:created',
    });

    expect(result.outcome).toBe('queued');

    // findExistingJobForHead receives vcsProvider='bitbucket' (NOT the default 'github').
    expect(findExistingJobForHeadSpy).toHaveBeenCalledTimes(1);
    const dedupCall = findExistingJobForHeadSpy.mock.calls[0][1];
    expect(dedupCall.vcsProvider).toBe('bitbucket');

    // supersedeOlderJobs receives vcsProvider='bitbucket' (the chain threads provider through).
    expect(supersedeOlderJobsSpy).toHaveBeenCalledTimes(1);
    const supersedeCall = supersedeOlderJobsSpy.mock.calls[0][1];
    expect(supersedeCall.vcsProvider).toBe('bitbucket');

    // Queue message carries provider: 'bitbucket' (the explicit effectiveProvider path).
    const sent = (env.REVIEW_QUEUE as any).sent;
    expect(sent).toHaveLength(1);
    expect(sent[0].provider).toBe('bitbucket');
  });

  it('Test 7 (provider passthrough on queued-event path with bitbucket explicit): reviewRequest:null + provider:bitbucket', async () => {
    const deliveryId = `delivery-bb-e-${Date.now()}`;

    const result = await ingestReviewWebhookEvent(env, {
      reviewRequest: null,
      configSnapshot: defaultRepoConfig,
      deliveryId,
      requestId: 'req-bb-e',
      eventName: 'issue_comment',
      provider: 'bitbucket',
    });

    expect(result).toEqual({ outcome: 'queued_event' });

    const sent = (env.REVIEW_QUEUE as any).sent;
    expect(sent).toHaveLength(1);
    expect(sent[0].provider).toBe('bitbucket');
  });
});
