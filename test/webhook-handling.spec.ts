import { createApp } from '@server/app';
import { createMockPRWebhook, createTestEnv, signWebhookPayload as signPayload, hasConfiguredTestDatabaseUrl } from './helpers';
import { vi } from 'vitest';
import { queryRows } from '@server/db/client';
import { encryptSecret } from '@server/core/crypto';
import { defaultRepoConfig } from '@shared/schema';

// Mock GitHubClient to avoid real JWT signing and network calls
vi.mock('@server/core/github', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    GitHubClient: class {
      getInstallationToken = vi.fn().mockResolvedValue('fake-token');
      getRepoFileOrNull = vi.fn().mockResolvedValue(null);
    }
  };
});

// ---------------------------------------------------------------------------
// Phase 11 (Plan 07) seams. loadRepoConfig is mocked so the interactive (commands/qa) toggles are ON
// for the whole file — the pre-Phase-11 auto-review tests stay green because the returned config is
// defaultRepoConfig + interactive-on (ignore_drafts/triggers unchanged, so auto behavior is identical).
// ingestReviewWebhookEvent is spied PASSTHROUGH (records the input the route projected, then runs the
// real helper), so the existing route tests still exercise the real ingest/queue path. classifyComment
// is mocked so a command outcome can be forced deterministically without the real bot self-filter (that
// is covered by test/commands.spec.ts); executeCommand + authorizeActor stay REAL so the end-to-end
// reject test persists a real reject_feedback row. job-recovery is a no-op so the consumer path does not
// touch the maintenance sweeps.
// ---------------------------------------------------------------------------
const { ingestSpy, loadRepoConfigMock, forProviderMock, classifyCommentMock } = vi.hoisted(() => ({
  ingestSpy: vi.fn(),
  loadRepoConfigMock: vi.fn(),
  forProviderMock: vi.fn(),
  classifyCommentMock: vi.fn(),
}));

vi.mock('@server/core/webhook-ingest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@server/core/webhook-ingest')>();
  return {
    ...actual,
    ingestReviewWebhookEvent: (...args: any[]) => {
      ingestSpy(...args);
      return (actual.ingestReviewWebhookEvent as any)(...args);
    },
  };
});

vi.mock('@server/core/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@server/core/config')>();
  return { ...actual, loadRepoConfig: (...args: any[]) => loadRepoConfigMock(...args) };
});

vi.mock('@server/services/vcs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@server/services/vcs')>();
  return { ...actual, VcsService: Object.assign(actual.VcsService, { forProvider: forProviderMock }) };
});

vi.mock('@server/core/commands', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@server/core/commands')>();
  return { ...actual, classifyComment: classifyCommentMock };
});

vi.mock('@server/core/job-recovery', () => ({
  runBestEffortJobMaintenance: vi.fn().mockResolvedValue(undefined),
}));

import worker from '@server/index';

function enabledInteractiveConfig() {
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
  };
}

// The fake provider the seam constructs: getUserRepoPermission → 'write' so authorizeActor authorizes
// the reject; name mirrors the requested provider so authorizeActor takes the right branch.
function fakeProvider(opts: any) {
  return {
    name: opts?.provider ?? 'github',
    getUserRepoPermission: async () => 'write',
    resolveBotUserIdentity: async () => ({ accountId: 'bot-acct-xyz', login: 'codra-bot' }),
    getPullRequest: async () => ({
      number: 1, title: 't', body: 'b', draft: false,
      headSha: 'h', headRef: 'f', baseSha: 'base', baseRef: 'main', authorLogin: 'dev',
    }),
    createPrComment: async () => ({ ref: 'ref' }),
  };
}

function setInteractiveMocks() {
  loadRepoConfigMock.mockReset();
  forProviderMock.mockReset();
  classifyCommentMock.mockReset();
  ingestSpy.mockClear();
  loadRepoConfigMock.mockResolvedValue({ parsedJson: enabledInteractiveConfig(), enabled: true });
  forProviderMock.mockImplementation((_env: any, opts: any) => Promise.resolve(fakeProvider(opts)));
  classifyCommentMock.mockResolvedValue({ kind: 'ignored', reason: 'not_mention' });
}

describe('Webhook Handling Suite', () => {
  const env = createTestEnv();
  const app = createApp();

  beforeEach(() => {
    (env.REVIEW_QUEUE as any).sent.length = 0;
    setInteractiveMocks();
  });

  it('rejects webhooks with invalid signatures', async () => {
    const payload = JSON.stringify(createMockPRWebhook());
    const response = await app.request(
      'http://codra.test/webhook',
      {
        method: 'POST',
        headers: {
          'x-github-event': 'pull_request',
          'x-github-delivery': 'delivery-inv',
          'x-hub-signature-256': 'sha256=invalid',
        },
        body: payload,
      },
      env,
    );

    expect(response.status).toBe(401);
  });

  it('rejects signed malformed webhook JSON with a 400', async () => {
    const body = '{"not": "valid"';
    const signature = await signPayload(env.GITHUB_APP_WEBHOOK_SECRET, body);

    const response = await app.request(
      'http://codra.test/webhook',
      {
        method: 'POST',
        headers: {
          'x-github-event': 'pull_request',
          'x-github-delivery': `malformed-${Date.now()}`,
          'x-hub-signature-256': signature,
          'content-type': 'application/json',
        },
        body,
      },
      env,
    );

    expect(response.status).toBe(400);
  });

  it('accepts valid pull_request.opened and queues a job', async () => {
    const repoName = `repo-${Date.now()}`;
    const rawPayload = createMockPRWebhook({
        action: 'opened',
        repository: { name: repoName, owner: { login: 'test-owner' } }
    });
    rawPayload.pull_request.head.sha = 'a'.repeat(40);
    rawPayload.pull_request.base.sha = 'b'.repeat(40);
    const body = JSON.stringify(rawPayload);
    const signature = await signPayload(env.GITHUB_APP_WEBHOOK_SECRET, body);

    const response = await app.request(
      'http://codra.test/webhook',
      {
        method: 'POST',
        headers: {
          'x-github-event': 'pull_request',
          'x-github-delivery': `delivery-${Date.now()}`,
          'x-hub-signature-256': signature,
          'content-type': 'application/json',
        },
        body,
      },
      env,
    );

    const json = await response.json() as any;
    expect(response.status).toBe(202);
    expect(json.ok).toBe(true);
    expect(json.message).toBe('queued');
    expect(json.job.status).toBe('queued');

    const queue = env.REVIEW_QUEUE as any;
    expect(queue.sent).toHaveLength(1);
    expect(queue.sent[0].jobId).toBe(json.job.id);
    expect(queue.sent[0].deliveryId).toBeDefined();
    expect(queue.sent[0].phase).toBe('prepare');
    expect(queue.sent[0].eventName).toBeUndefined();
    expect(queue.sent[0].payload).toBeUndefined();
  });

  it('rejects GitHub webhooks posted to the site root', async () => {
    const repoName = `root-repo-${Date.now()}`;
    const rawPayload = createMockPRWebhook({
      action: 'opened',
      repository: { name: repoName, owner: { login: 'test-owner' } }
    });
    rawPayload.pull_request.head.sha = 'c'.repeat(40);
    rawPayload.pull_request.base.sha = 'd'.repeat(40);
    const body = JSON.stringify(rawPayload);
    const signature = await signPayload(env.GITHUB_APP_WEBHOOK_SECRET, body);

    const response = await app.request(
      'http://codra.test/',
      {
        method: 'POST',
        headers: {
          'x-github-event': 'pull_request',
          'x-github-delivery': `root-delivery-${Date.now()}`,
          'x-hub-signature-256': signature,
          'content-type': 'application/json',
        },
        body,
      },
      env,
    );

    expect(response.status).toBe(404);

    const queue = env.REVIEW_QUEUE as any;
    expect(queue.sent).toHaveLength(0);
  });

  it('acknowledges unsupported GitHub events without queueing review work', async () => {
    const rawPayload = createMockPRWebhook({
      action: 'opened',
      repository: { name: `repo-${Date.now()}-check-suite`, owner: { login: 'test-owner' } },
    });
    const body = JSON.stringify(rawPayload);
    const signature = await signPayload(env.GITHUB_APP_WEBHOOK_SECRET, body);

    const response = await app.request(
      'http://codra.test/webhook',
      {
        method: 'POST',
        headers: {
          'x-github-event': 'check_suite',
          'x-github-delivery': `check-suite-${Date.now()}`,
          'x-hub-signature-256': signature,
          'content-type': 'application/json',
        },
        body,
      },
      env,
    );

    const json = await response.json() as any;
    expect(response.status).toBe(202);
    expect(json.ok).toBe(true);
    expect(json.ignored).toBe(true);
    expect(json.eventName).toBe('check_suite');

    const queue = env.REVIEW_QUEUE as any;
    expect(queue.sent).toHaveLength(0);
  });

  it('ignores webhooks for draft PRs', async () => {
      const draftPayload = createMockPRWebhook({
          action: 'opened',
          pull_request: { draft: true, number: 99, head: { sha: 'abc' }, base: { sha: 'def' }, user: { login: 'a' } }
      });
      const body = JSON.stringify(draftPayload);
      const signature = await signPayload(env.GITHUB_APP_WEBHOOK_SECRET, body);

      const response = await app.request(
        'http://codra.test/webhook',
        {
          method: 'POST',
          headers: {
            'x-github-event': 'pull_request',
            'x-github-delivery': `draft-${Date.now()}`,
            'x-hub-signature-256': signature,
          },
          body,
        },
        env,
      );

      const json = await response.json() as any;
      expect(response.status).toBe(202);
      expect(json.message).toBe('queued');

      const queue = env.REVIEW_QUEUE as any;
      expect(queue.sent).toHaveLength(1);
      expect(queue.sent[0].payload).toBeUndefined();
      expect(queue.sent[0].eventName).toBe('pull_request');
  });
});

// ---------------------------------------------------------------------------
// Phase 11 (Plan 07): the GitHub route now projects issue_comment AND pull_request_review_comment into
// a provider-agnostic CommentContext keyed on the IMMUTABLE numeric id, forwards prBody on the AUTO
// event, and routes reply-under-finding reject via in_reply_to_id → findingRef. Route/subscription/
// projection assertions live here (the HTTP layer). Two end-to-end signed-route→queue→consumer→
// reject_feedback tests (one per provider) prove reject_feedback.reason is non-null on both.
// ---------------------------------------------------------------------------
const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;

dbDescribe('Webhook Handling — Phase 11 comment dispatch (GitHub)', () => {
  const env = createTestEnv();
  const app = createApp();

  beforeEach(() => {
    (env.REVIEW_QUEUE as any).sent.length = 0;
    setInteractiveMocks();
  });

  function issueCommentPayload(opts: {
    repo: string; prNumber: number; commentId: number; userId: number; login: string; body: string; inReplyTo?: number;
  }) {
    return {
      action: 'created',
      installation: { id: 424242 },
      repository: { name: opts.repo, owner: { login: 'gh-owner' } },
      issue: { number: opts.prNumber, pull_request: { url: 'https://api.github.com/pr' } },
      comment: {
        id: opts.commentId,
        body: opts.body,
        user: { id: opts.userId, login: opts.login },
        ...(opts.inReplyTo !== undefined ? { in_reply_to_id: opts.inReplyTo } : {}),
      },
    };
  }

  function reviewCommentPayload(opts: {
    repo: string; prNumber: number; commentId: number; userId: number; login: string; body: string; inReplyTo?: number;
  }) {
    return {
      action: 'created',
      installation: { id: 424242 },
      repository: { name: opts.repo, owner: { login: 'gh-owner' } },
      pull_request: { number: opts.prNumber },
      comment: {
        id: opts.commentId,
        body: opts.body,
        user: { id: opts.userId, login: opts.login },
        path: 'src/foo.ts',
        ...(opts.inReplyTo !== undefined ? { in_reply_to_id: opts.inReplyTo } : {}),
      },
    };
  }

  async function postGithub(eventName: string, payload: unknown, deliveryId: string) {
    const body = JSON.stringify(payload);
    const signature = await signPayload(env.GITHUB_APP_WEBHOOK_SECRET, body);
    return app.request(
      'http://codra.test/webhook',
      {
        method: 'POST',
        headers: {
          'x-github-event': eventName,
          'x-github-delivery': deliveryId,
          'x-hub-signature-256': signature,
          'content-type': 'application/json',
        },
        body,
      },
      env,
    );
  }

  it('projects an issue_comment command keyed on the immutable numeric id and enqueues { kind:command }', async () => {
    classifyCommentMock.mockResolvedValue({ kind: 'command', name: 'pause', args: '' });
    const payload = issueCommentPayload({
      repo: `gh-ic-${Date.now()}`, prNumber: 5, commentId: 9001, userId: 777, login: 'human', body: '@codra-app pause',
    });

    const response = await postGithub('issue_comment', payload, `del-ic-${Date.now()}`);
    expect(response.status).toBe(202);

    // Route projection: commentContext keyed on String(comment.user.id), NEVER the login.
    const ctx = ingestSpy.mock.calls[0][1].commentContext;
    expect(ctx.authorId).toBe('777');
    expect(ctx.authorLogin).toBe('human');
    expect(ctx.prNumber).toBe(5);
    expect(ctx.commentRef).toBe('9001');
    expect(ctx.workspace).toBe('gh-owner');

    // The seam enqueues a command message (real ingest) keyed on the numeric id.
    const sent = (env.REVIEW_QUEUE as any).sent;
    expect(sent).toHaveLength(1);
    expect(sent[0].kind).toBe('command');
    expect(sent[0].interactive.commandName).toBe('pause');
    expect(sent[0].interactive.authorId).toBe('777');
  });

  it('projects findingRef from pull_request_review_comment.in_reply_to_id (reply-under-finding reject)', async () => {
    classifyCommentMock.mockResolvedValue({ kind: 'command', name: 'reject', args: 'not a bug' });
    const payload = reviewCommentPayload({
      repo: `gh-rc-${Date.now()}`, prNumber: 8, commentId: 5555, userId: 42, login: 'human', body: '@codra-app reject not a bug', inReplyTo: 4444,
    });

    const response = await postGithub('pull_request_review_comment', payload, `del-rc-${Date.now()}`);
    expect(response.status).toBe(202);

    // The route maps in_reply_to_id → findingRef (parity with Bitbucket comment.parent.id, D-09).
    const ctx = ingestSpy.mock.calls[0][1].commentContext;
    expect(ctx.findingRef).toBe('4444');
    expect(ctx.commentRef).toBe('5555');
    expect(ctx.authorId).toBe('42');

    const sent = (env.REVIEW_QUEUE as any).sent;
    expect(sent).toHaveLength(1);
    expect(sent[0].kind).toBe('command');
    // findingRef threads through to the command message so the consumer persists it.
    expect(sent[0].interactive.findingRef).toBe('4444');
  });

  it('forwards prBody = pull_request.body on the AUTO pull_request event (CMD-06 ignore gate)', async () => {
    const rawPayload = createMockPRWebhook({
      action: 'opened',
      repository: { name: `gh-auto-${Date.now()}`, owner: { login: 'gh-owner' } },
    });
    rawPayload.pull_request.head.sha = 'e'.repeat(40);
    rawPayload.pull_request.base.sha = 'f'.repeat(40);
    rawPayload.pull_request.body = '@codra-app ignore this PR';

    const response = await postGithub('pull_request', rawPayload, `del-auto-${Date.now()}`);
    expect([202]).toContain(response.status);

    const ingestInput = ingestSpy.mock.calls[0][1];
    expect(ingestInput.prBody).toBe('@codra-app ignore this PR');
    expect(ingestInput.commentContext).toBeUndefined();
  });

  it('END-TO-END: a signed pull_request_review_comment reject flows route→queue→consumer→reject_feedback (reason non-null)', async () => {
    const uniq = Date.now();
    const repo = `gh-e2e-${uniq}`;
    const commentId = 700000 + (uniq % 100000);
    const inReplyTo = 800000 + (uniq % 100000);
    const rejectBody = '@codra-app reject this is a false positive';

    // classifyComment (mocked) → reject; findingRef falls back to ctx.findingRef (= String(in_reply_to_id)).
    classifyCommentMock.mockResolvedValue({ kind: 'command', name: 'reject', args: 'this is a false positive' });

    const payload = reviewCommentPayload({
      repo, prNumber: 3, commentId, userId: 99, login: 'human', body: rejectBody, inReplyTo,
    });
    const response = await postGithub('pull_request_review_comment', payload, `del-e2e-gh-${uniq}`);
    expect(response.status).toBe(202);

    const sent = (env.REVIEW_QUEUE as any).sent;
    expect(sent).toHaveLength(1);
    expect(sent[0].kind).toBe('command');

    // Drive the consumer with the enqueued message (strip MockQueue's `options` envelope key).
    const { options: _o, ...messageBody } = sent[0];
    const message = { body: messageBody, ack: vi.fn(), retry: vi.fn(), attempts: 1 };
    await worker.queue({ messages: [message] } as any, env, {} as ExecutionContext);
    expect(message.ack).toHaveBeenCalledTimes(1);

    const [row] = await queryRows<{ reason: string | null; finding_ref: string }>(
      env,
      `SELECT reason, finding_ref FROM reject_feedback WHERE vcs_provider = 'github' AND source_comment_ref = $1`,
      [String(commentId)],
    );
    expect(row).toBeDefined();
    expect(row.reason).toBe(rejectBody);
    expect(row.finding_ref).toBe(String(inReplyTo));

    await queryRows(env, `DELETE FROM reject_feedback WHERE vcs_provider = 'github' AND source_comment_ref = $1`, [String(commentId)]);
  });
});

dbDescribe('Webhook Handling — Phase 11 comment dispatch (Bitbucket end-to-end)', () => {
  const env = createTestEnv();
  const app = createApp();

  const createdRepoIds: number[] = [];
  const createdIdentities: Array<{ workspace: string; repoSlug: string }> = [];
  const createdCommentRefs: string[] = [];

  beforeEach(() => {
    (env.REVIEW_QUEUE as any).sent.length = 0;
    setInteractiveMocks();
  });

  afterEach(async () => {
    for (const ref of createdCommentRefs) {
      await queryRows(env, `DELETE FROM reject_feedback WHERE vcs_provider = 'bitbucket' AND source_comment_ref = $1`, [ref]);
    }
    createdCommentRefs.length = 0;
    for (const { workspace, repoSlug } of createdIdentities) {
      await queryRows(env, 'DELETE FROM vcs_credentials WHERE workspace = $1 AND repo_slug = $2', [workspace, repoSlug]);
    }
    createdIdentities.length = 0;
    if (createdRepoIds.length > 0) {
      await queryRows(env, 'DELETE FROM webhook_deliveries WHERE repository_id = ANY($1::int[])', [createdRepoIds]);
      await queryRows(env, 'DELETE FROM repo_configs WHERE repository_id = ANY($1::int[])', [createdRepoIds]);
      await queryRows(env, 'DELETE FROM jobs WHERE repository_id = ANY($1::int[])', [createdRepoIds]);
      await queryRows(env, 'DELETE FROM repositories WHERE id = ANY($1::int[])', [createdRepoIds]);
      createdRepoIds.length = 0;
    }
  });

  const BB_SECRET = 'bitbucket-shared-secret';

  async function seed(workspace: string, repoSlug: string) {
    const [row] = await queryRows<{ id: number }>(
      env,
      `INSERT INTO repositories (vcs_provider, owner, repo, workspace) VALUES ('bitbucket', $1, $2, $1) RETURNING id`,
      [workspace, repoSlug],
    );
    if (!row) throw new Error('seed: no repository row');
    createdRepoIds.push(row.id);
    // Per-repo config with interactive commands enabled — the route reads this by repository_id
    // (provider-safe) and merges review.interactive so Bitbucket commands are enabled (NREG-02).
    await queryRows(
      env,
      `INSERT INTO repo_configs (repository_id, parsed_json, updated_at, enabled) VALUES ($1, $2::jsonb, now(), true)`,
      [row.id, JSON.stringify(enabledInteractiveConfig())],
    );
    const encrypted = await encryptSecret(env, BB_SECRET);
    await queryRows(
      env,
      `INSERT INTO vcs_credentials (vcs_provider, workspace, repo_slug, encrypted_webhook_secret, encrypted_access_token, created_at, updated_at)
       VALUES ('bitbucket', $1, $2, $3, 'placeholder-encrypted-token', now(), now())`,
      [workspace, repoSlug, encrypted],
    );
    createdIdentities.push({ workspace, repoSlug });
    return row.id;
  }

  it('END-TO-END: a signed pullrequest:comment_created reject (comment.parent.id) flows route→queue→consumer→reject_feedback (reason non-null)', async () => {
    const uniq = Date.now();
    const workspace = `ws-e2e-${uniq}`;
    const repoSlug = `repo-e2e-${uniq}`;
    await seed(workspace, repoSlug);

    classifyCommentMock.mockResolvedValue({ kind: 'command', name: 'reject', args: 'false positive' });

    const prId = 15;
    const commentId = 6001;
    const parentId = 5001;
    const rejectBody = '@codra-app reject false positive';
    const commentRef = `${prId}:${commentId}`;
    const findingRef = `${prId}:${parentId}`;
    createdCommentRefs.push(commentRef);

    const payload = {
      repository: { full_name: `${workspace}/${repoSlug}`, name: repoSlug, workspace: { slug: workspace }, uuid: '{u-e2e}' },
      pullrequest: {
        id: prId,
        title: 'PR',
        state: 'OPEN',
        description: 'desc',
        source: { branch: { name: 'feature' }, commit: { hash: 'a'.repeat(40) } },
        destination: { branch: { name: 'main' }, commit: { hash: 'b'.repeat(40) } },
      },
      comment: {
        id: commentId,
        content: { raw: rejectBody },
        user: { account_id: 'acct-human-e2e', nickname: 'human' },
        parent: { id: parentId },
      },
      actor: { username: 'bb-dev' },
    };
    const body = JSON.stringify(payload);
    const signature = await signPayload(BB_SECRET, body);

    const response = await app.request(
      'http://codra.test/webhook/bitbucket',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-event-key': 'pullrequest:comment_created',
          'x-request-uuid': `del-e2e-bb-${uniq}`,
          'x-hub-signature': signature,
        },
        body,
      },
      env,
    );
    expect([200, 202]).toContain(response.status);

    const sent = (env.REVIEW_QUEUE as any).sent;
    expect(sent).toHaveLength(1);
    expect(sent[0].kind).toBe('command');
    expect(sent[0].provider).toBe('bitbucket');
    expect(sent[0].interactive.findingRef).toBe(findingRef);

    const { options: _o, ...messageBody } = sent[0];
    const message = { body: messageBody, ack: vi.fn(), retry: vi.fn(), attempts: 1 };
    await worker.queue({ messages: [message] } as any, env, {} as ExecutionContext);
    expect(message.ack).toHaveBeenCalledTimes(1);

    const [row] = await queryRows<{ reason: string | null; finding_ref: string }>(
      env,
      `SELECT reason, finding_ref FROM reject_feedback WHERE vcs_provider = 'bitbucket' AND source_comment_ref = $1`,
      [commentRef],
    );
    expect(row).toBeDefined();
    expect(row.reason).toBe(rejectBody);
    expect(row.finding_ref).toBe(findingRef);
  });
});
