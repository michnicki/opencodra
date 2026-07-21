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
import type { RepoConfig } from '@shared/schema';
import type { ReviewRequest } from '@server/core/review';
import type { CommentContext } from '@server/core/commands';
import { insertSkippedFiles } from '@server/db/skipped-files';

const sha = (char: string) => char.repeat(40);

// ---------------------------------------------------------------------------
// 11-06 comment-classification branch mocks. Spy the provider factory + the Plan 03 classifier so
// the routing logic (which the plan owns) is tested in isolation from the real GitHub API / bot
// self-filter (already covered by test/commands.spec.ts). Tests 1-7 above never set commentContext,
// so they never touch these mocks and stay byte-identical (NREG-01).
// ---------------------------------------------------------------------------
const { forProviderMock, classifyCommentMock, authorizeActorMock, getPullRequestMock } = vi.hoisted(() => ({
  forProviderMock: vi.fn(),
  classifyCommentMock: vi.fn(),
  authorizeActorMock: vi.fn(),
  getPullRequestMock: vi.fn(),
}));

vi.mock('@server/services/vcs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@server/services/vcs')>();
  return {
    ...actual,
    // Keep the real class (forRepo etc.) but override the static forProvider used by the branch.
    VcsService: Object.assign(actual.VcsService, { forProvider: forProviderMock }),
  };
});

vi.mock('@server/core/commands', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@server/core/commands')>();
  return {
    ...actual,
    classifyComment: classifyCommentMock,
    authorizeActor: authorizeActorMock,
  };
});

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

// ---------------------------------------------------------------------------
// 11-06: the EXCLUSIVE comment-classification branch (CMD-05/06/07). classifyComment + the provider
// factory are mocked; the DB (insertJob / listSkippedFilesForHead / mostRecentJobForPullRequest) is
// real. Asserts the routing contract: every classification outcome returns explicitly and NEVER
// falls through to the queued_event path.
// ---------------------------------------------------------------------------
function commandsEnabledConfig(): RepoConfig {
  return {
    ...defaultRepoConfig,
    review: {
      ...defaultRepoConfig.review,
      interactive: {
        ...defaultRepoConfig.review.interactive,
        commands: { ...defaultRepoConfig.review.interactive.commands, enabled: true },
        qa: { ...defaultRepoConfig.review.interactive.qa, enabled: true },
      },
    },
  } as RepoConfig;
}

dbDescribe('ingestReviewWebhookEvent (Phase 11 comment classification)', () => {
  const env = createTestEnv();

  const fakeProvider = { name: 'github' as const, getPullRequest: getPullRequestMock };

  function buildCommentContext(overrides: Partial<CommentContext> = {}): CommentContext {
    const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const owner = `owner-cc-${uniq}`;
    return {
      authorId: 'user-123',
      authorLogin: 'reviewer',
      body: '@codra-app review',
      prNumber: 7,
      owner,
      repo: `repo-cc-${uniq}`,
      workspace: owner,
      ...overrides,
    };
  }

  // A mention-shaped reviewRequest carries the installationId the GitHub comment branch needs to
  // build the provider + insert the job (the route threads it alongside commentContext).
  function mentionReviewRequest(ctx: CommentContext): ReviewRequest {
    return {
      installationId: '123',
      owner: ctx.owner,
      repo: ctx.repo,
      prNumber: ctx.prNumber,
      prTitle: null,
      prAuthor: null,
      commitSha: '',
      baseSha: '',
      headRef: null,
      baseRef: null,
      trigger: 'mention',
    };
  }

  beforeEach(() => {
    (env.REVIEW_QUEUE as any).sent.length = 0;
    forProviderMock.mockReset();
    classifyCommentMock.mockReset();
    authorizeActorMock.mockReset();
    getPullRequestMock.mockReset();
    forProviderMock.mockResolvedValue(fakeProvider);
  });

  it('Test 8: a self_filtered comment returns ignored_comment and sends NO queue message', async () => {
    classifyCommentMock.mockResolvedValue({ kind: 'ignored', reason: 'self_filtered' });
    const ctx = buildCommentContext();

    const result = await ingestReviewWebhookEvent(env, {
      reviewRequest: mentionReviewRequest(ctx),
      configSnapshot: commandsEnabledConfig(),
      deliveryId: `delivery-t8-${Date.now()}`,
      requestId: 'req-t8',
      eventName: 'issue_comment',
      commentContext: ctx,
    });

    expect(result).toEqual({ outcome: 'ignored_comment', reason: 'self_filtered' });
    expect(classifyCommentMock).toHaveBeenCalledTimes(1);
    expect((env.REVIEW_QUEUE as any).sent).toHaveLength(0);
  });

  it('Test 9: both features off => ignored_comment feature_disabled WITHOUT calling classifyComment', async () => {
    const ctx = buildCommentContext();

    const result = await ingestReviewWebhookEvent(env, {
      reviewRequest: mentionReviewRequest(ctx),
      configSnapshot: defaultRepoConfig, // commands + qa both disabled
      deliveryId: `delivery-t9-${Date.now()}`,
      requestId: 'req-t9',
      eventName: 'issue_comment',
      commentContext: ctx,
    });

    expect(result).toEqual({ outcome: 'ignored_comment', reason: 'feature_disabled' });
    expect(classifyCommentMock).not.toHaveBeenCalled();
    expect(forProviderMock).not.toHaveBeenCalled();
    expect((env.REVIEW_QUEUE as any).sent).toHaveLength(0);
  });

  it('Test 10: command review hydrates SHAs and inserts a FRESH job even when a terminal job exists', async () => {
    const ctx = buildCommentContext();

    // A prior terminal job for the SAME PR exists — the rerun path must NOT dedupe against it.
    const priorJob = await insertJob(env, {
      installationId: '123',
      owner: ctx.owner,
      repo: ctx.repo,
      prNumber: ctx.prNumber,
      prTitle: 'Prior',
      prAuthor: 'author',
      commitSha: sha('a'),
      baseSha: sha('b'),
      trigger: 'auto',
      headRef: 'feature',
      baseRef: 'main',
      configSnapshot: defaultRepoConfig,
    });

    classifyCommentMock.mockResolvedValue({ kind: 'command', name: 'review', args: '' });
    authorizeActorMock.mockResolvedValue(true);
    getPullRequestMock.mockResolvedValue({
      number: ctx.prNumber,
      title: 'Hydrated title',
      body: 'desc',
      draft: false,
      headSha: sha('c'),
      headRef: 'feature',
      baseSha: sha('d'),
      baseRef: 'main',
      authorLogin: 'dev',
    });

    const result = await ingestReviewWebhookEvent(env, {
      reviewRequest: mentionReviewRequest(ctx),
      configSnapshot: commandsEnabledConfig(),
      deliveryId: `delivery-t10-${Date.now()}`,
      requestId: 'req-t10',
      eventName: 'issue_comment',
      commentContext: ctx,
    });

    expect(result.outcome).toBe('queued');
    expect(authorizeActorMock).toHaveBeenCalledTimes(1);
    expect(getPullRequestMock).toHaveBeenCalledTimes(1);
    if (result.outcome === 'queued') {
      // A brand-new job, not the prior terminal one (no dedupe).
      expect(result.job.id).not.toBe(priorJob.id);
      const fresh = await getJobForProcessing(env, result.job.id);
      expect(fresh?.status).toBe('queued');
      // review_scope 'all' persisted on the inserted row (drives Plan 05 getJobDiffFiles).
      expect(fresh?.review_scope).toBe('all');
    }

    // A no-kind review message reaches the Workflow path (NREG-01) — never a command/qa kind.
    const sent = (env.REVIEW_QUEUE as any).sent;
    expect(sent).toHaveLength(1);
    expect(sent[0].kind).toBeUndefined();
    expect(sent[0].phase).toBe('prepare');
    expect(sent[0].jobId).toBe((result as any).job.id);
  });

  it('Test 11: review-rest with an empty skip set does NOT insert a job', async () => {
    const ctx = buildCommentContext({ body: '@codra-app review rest' });

    classifyCommentMock.mockResolvedValue({ kind: 'command', name: 'review-rest', args: '' });
    authorizeActorMock.mockResolvedValue(true);
    getPullRequestMock.mockResolvedValue({
      number: ctx.prNumber,
      title: 't',
      body: 'b',
      draft: false,
      headSha: sha('e'),
      headRef: 'feature',
      baseSha: sha('f'),
      baseRef: 'main',
      authorLogin: 'dev',
    });

    const result = await ingestReviewWebhookEvent(env, {
      reviewRequest: mentionReviewRequest(ctx),
      configSnapshot: commandsEnabledConfig(),
      deliveryId: `delivery-t11-${Date.now()}`,
      requestId: 'req-t11',
      eventName: 'issue_comment',
      commentContext: ctx,
    });

    expect(result).toEqual({ outcome: 'ignored_comment', reason: 'no_skipped_files' });
    // No job inserted => no review message enqueued.
    expect((env.REVIEW_QUEUE as any).sent).toHaveLength(0);
  });

  it('Test 11b: review-rest WITH a recorded skip set inserts a rest-scoped job', async () => {
    const ctx = buildCommentContext({ body: '@codra-app review rest' });
    const headSha = sha('9');

    // Seed a prior full-review job + its skipped files at this head so review-rest has work to do.
    const sourceJob = await insertJob(env, {
      installationId: '123',
      owner: ctx.owner,
      repo: ctx.repo,
      prNumber: ctx.prNumber,
      prTitle: 'Source',
      prAuthor: 'author',
      commitSha: headSha,
      baseSha: sha('8'),
      trigger: 'auto',
      headRef: 'feature',
      baseRef: 'main',
      configSnapshot: defaultRepoConfig,
    });
    await insertSkippedFiles(env, {
      jobId: sourceJob.id,
      vcsProvider: 'github',
      workspace: ctx.workspace,
      repoSlug: ctx.repo,
      prNumber: ctx.prNumber,
      headSha,
      files: [{ filePath: 'src/skipped.ts', reason: 'max_files' }],
    });

    classifyCommentMock.mockResolvedValue({ kind: 'command', name: 'review-rest', args: '' });
    authorizeActorMock.mockResolvedValue(true);
    getPullRequestMock.mockResolvedValue({
      number: ctx.prNumber,
      title: 't',
      body: 'b',
      draft: false,
      headSha,
      headRef: 'feature',
      baseSha: sha('8'),
      baseRef: 'main',
      authorLogin: 'dev',
    });

    const result = await ingestReviewWebhookEvent(env, {
      reviewRequest: mentionReviewRequest(ctx),
      configSnapshot: commandsEnabledConfig(),
      deliveryId: `delivery-t11b-${Date.now()}`,
      requestId: 'req-t11b',
      eventName: 'issue_comment',
      commentContext: ctx,
    });

    expect(result.outcome).toBe('queued');
    if (result.outcome === 'queued') {
      const fresh = await getJobForProcessing(env, result.job.id);
      expect(fresh?.review_scope).toBe('rest');
      // scope_source_job_id links to the latest source job for this PR.
      expect(fresh?.scope_source_job_id).toBeTruthy();
    }
  });

  it('Test 12: pause command enqueues { kind:command } carrying body + workspace + authorId (D-09)', async () => {
    const ctx = buildCommentContext({
      body: '@codra-app pause',
      authorId: 'pauser-9',
      commentRef: 'c-42',
      threadable: true,
    });

    classifyCommentMock.mockResolvedValue({ kind: 'command', name: 'pause', args: '' });

    const result = await ingestReviewWebhookEvent(env, {
      reviewRequest: mentionReviewRequest(ctx),
      configSnapshot: commandsEnabledConfig(),
      deliveryId: `delivery-t12-${Date.now()}`,
      requestId: 'req-t12',
      eventName: 'issue_comment',
      commentContext: ctx,
    });

    expect(result).toEqual({ outcome: 'command_enqueued' });
    // Authorization is deferred to the consumer's executeCommand — not run at ingest.
    expect(authorizeActorMock).not.toHaveBeenCalled();

    const sent = (env.REVIEW_QUEUE as any).sent;
    expect(sent).toHaveLength(1);
    expect(sent[0].kind).toBe('command');
    expect(sent[0].interactive.commandName).toBe('pause');
    expect(sent[0].interactive.body).toBe('@codra-app pause');
    expect(sent[0].interactive.workspace).toBe(ctx.workspace);
    expect(sent[0].interactive.authorId).toBe('pauser-9');
    expect(sent[0].interactive.sourceCommentRef).toBe('c-42');
    // Phase 12 (D-03): threadable rides the command payload, mirroring the input context.
    expect(sent[0].interactive.threadable).toBe(ctx.threadable);
    expect(sent[0].interactive.threadable).toBe(true);
  });

  it('Test 13: a qa comment enqueues { kind:qa } and never a job', async () => {
    const ctx = buildCommentContext({
      body: '@codra-app why is this slow?',
      commentRef: 'qa-c-77',
      threadable: true,
    });

    classifyCommentMock.mockResolvedValue({ kind: 'qa', question: 'why is this slow?' });

    const result = await ingestReviewWebhookEvent(env, {
      reviewRequest: mentionReviewRequest(ctx),
      configSnapshot: commandsEnabledConfig(),
      deliveryId: `delivery-t13-${Date.now()}`,
      requestId: 'req-t13',
      eventName: 'issue_comment',
      commentContext: ctx,
    });

    expect(result).toEqual({ outcome: 'qa_enqueued' });
    const sent = (env.REVIEW_QUEUE as any).sent;
    expect(sent).toHaveLength(1);
    expect(sent[0].kind).toBe('qa');
    expect(sent[0].interactive.question).toBe('why is this slow?');
    expect(sent[0].interactive.body).toBe('@codra-app why is this slow?');
    expect(sent[0].interactive.workspace).toBe(ctx.workspace);
    // Phase 12 (D-03, Pitfall #4): the qa payload now carries BOTH commentRef and threadable — the
    // reply target the inline consumer's answerQuestion threads under. Neither rode the qa payload
    // before this plan.
    expect(sent[0].interactive.commentRef).toBe('qa-c-77');
    expect(sent[0].interactive.commentRef).toBe(ctx.commentRef);
    expect(sent[0].interactive.threadable).toBe(ctx.threadable);
    expect(sent[0].interactive.threadable).toBe(true);
  });

  it('Test 14: an unauthorized command review is silently ignored (no job, no queue message)', async () => {
    const ctx = buildCommentContext();

    classifyCommentMock.mockResolvedValue({ kind: 'command', name: 'review', args: '' });
    authorizeActorMock.mockResolvedValue(false);
    getPullRequestMock.mockResolvedValue({
      number: ctx.prNumber,
      title: 't',
      body: 'b',
      draft: false,
      headSha: sha('1'),
      headRef: 'feature',
      baseSha: sha('2'),
      baseRef: 'main',
      authorLogin: 'dev',
    });

    const result = await ingestReviewWebhookEvent(env, {
      reviewRequest: mentionReviewRequest(ctx),
      configSnapshot: commandsEnabledConfig(),
      deliveryId: `delivery-t14-${Date.now()}`,
      requestId: 'req-t14',
      eventName: 'issue_comment',
      commentContext: ctx,
    });

    expect(result).toEqual({ outcome: 'ignored_comment', reason: 'unauthorized' });
    // getPullRequest is never reached when authorization fails.
    expect(getPullRequestMock).not.toHaveBeenCalled();
    expect((env.REVIEW_QUEUE as any).sent).toHaveLength(0);
  });
});
