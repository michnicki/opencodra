// Phase 11 Plan 06 — the commands-gated pause / ignore AUTO-gate in webhook-ingest (CMD-03/CMD-06,
// D-08). These tests drive the AUTO-review path directly (no commentContext), so classifyComment /
// the provider factory are never touched — only the DB-backed pause state (getPrReviewState) and the
// pure prBody ignore-directive parse. The gate is guarded by commands.enabled: with the feature OFF
// an @bot ignore body must NOT suppress an auto review (byte-identical to today); with it ON, a
// paused PR OR a leading ignore directive short-circuits before any job is created.

import { ingestReviewWebhookEvent } from '@server/core/webhook-ingest';
import { createTestEnv, hasConfiguredTestDatabaseUrl } from './helpers';
import { markPrPaused, markPrResumed } from '@server/db/pr-review-state';
import { defaultRepoConfig } from '@shared/schema';
import type { RepoConfig } from '@shared/schema';
import type { ReviewRequest } from '@server/core/review';

const sha = (char: string) => char.repeat(40);
const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;

function commandsEnabledConfig(): RepoConfig {
  return {
    ...defaultRepoConfig,
    review: {
      ...defaultRepoConfig.review,
      interactive: {
        ...defaultRepoConfig.review.interactive,
        commands: { ...defaultRepoConfig.review.interactive.commands, enabled: true },
      },
    },
  } as RepoConfig;
}

function buildAutoReviewRequest(overrides: Partial<ReviewRequest> = {}): ReviewRequest {
  const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    installationId: '123',
    owner: `owner-${uniq}`,
    repo: `repo-${uniq}`,
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

dbDescribe('ingestReviewWebhookEvent — pause / ignore auto-gate (11-06)', () => {
  const env = createTestEnv();

  beforeEach(() => {
    (env.REVIEW_QUEUE as any).sent.length = 0;
  });

  it('commands OFF: an @bot ignore body does NOT suppress an auto review (byte-identical)', async () => {
    const reviewRequest = buildAutoReviewRequest();

    const result = await ingestReviewWebhookEvent(env, {
      reviewRequest,
      configSnapshot: defaultRepoConfig, // commands disabled
      deliveryId: `delivery-off-${Date.now()}`,
      requestId: 'req-off',
      eventName: 'pull_request',
      prBody: '@codra-app ignore\n\nplease skip this one',
    });

    expect(result.outcome).toBe('queued');
    expect((env.REVIEW_QUEUE as any).sent).toHaveLength(1);
  });

  it('commands ON, not paused, no directive: an auto review is queued normally', async () => {
    const reviewRequest = buildAutoReviewRequest();

    const result = await ingestReviewWebhookEvent(env, {
      reviewRequest,
      configSnapshot: commandsEnabledConfig(),
      deliveryId: `delivery-on-${Date.now()}`,
      requestId: 'req-on',
      eventName: 'pull_request',
      prBody: 'A normal PR description with no directive.',
    });

    expect(result.outcome).toBe('queued');
    expect((env.REVIEW_QUEUE as any).sent).toHaveLength(1);
  });

  it('commands ON: a paused PR enqueues NO job on a new push (CMD-03, D-08)', async () => {
    const reviewRequest = buildAutoReviewRequest();
    await markPrPaused(
      env,
      { vcsProvider: 'github', workspace: reviewRequest.owner, repoSlug: reviewRequest.repo, prNumber: reviewRequest.prNumber },
      'pauser-1',
    );

    const result = await ingestReviewWebhookEvent(env, {
      reviewRequest,
      configSnapshot: commandsEnabledConfig(),
      deliveryId: `delivery-paused-${Date.now()}`,
      requestId: 'req-paused',
      eventName: 'pull_request',
    });

    expect(result).toEqual({ outcome: 'ignored_paused' });
    expect((env.REVIEW_QUEUE as any).sent).toHaveLength(0);
  });

  it('commands ON: a leading <mention> ignore directive suppresses the auto review (CMD-06)', async () => {
    const reviewRequest = buildAutoReviewRequest();

    const result = await ingestReviewWebhookEvent(env, {
      reviewRequest,
      configSnapshot: commandsEnabledConfig(),
      deliveryId: `delivery-directive-${Date.now()}`,
      requestId: 'req-directive',
      eventName: 'pull_request',
      prBody: 'Some intro line\n@codra-app ignore\nrest of the description',
    });

    expect(result).toEqual({ outcome: 'ignored_directive' });
    expect((env.REVIEW_QUEUE as any).sent).toHaveLength(0);
  });

  it('commands ON: resume clears the pause so a later auto review is queued again (no retro-trigger)', async () => {
    const reviewRequest = buildAutoReviewRequest();
    const key = { vcsProvider: 'github' as const, workspace: reviewRequest.owner, repoSlug: reviewRequest.repo, prNumber: reviewRequest.prNumber };

    await markPrPaused(env, key, 'pauser-1');
    // Resume clears the flag WITHOUT enqueuing anything itself (D-08).
    await markPrResumed(env, key, 'resumer-1');
    expect((env.REVIEW_QUEUE as any).sent).toHaveLength(0);

    const result = await ingestReviewWebhookEvent(env, {
      reviewRequest,
      configSnapshot: commandsEnabledConfig(),
      deliveryId: `delivery-resumed-${Date.now()}`,
      requestId: 'req-resumed',
      eventName: 'pull_request',
    });

    expect(result.outcome).toBe('queued');
    expect((env.REVIEW_QUEUE as any).sent).toHaveLength(1);
  });

  it('commands ON: an ignore directive with no mention boundary (@codra-appignore) does NOT suppress', async () => {
    const reviewRequest = buildAutoReviewRequest();

    const result = await ingestReviewWebhookEvent(env, {
      reviewRequest,
      configSnapshot: commandsEnabledConfig(),
      deliveryId: `delivery-boundary-${Date.now()}`,
      requestId: 'req-boundary',
      eventName: 'pull_request',
      prBody: '@codra-appignore this is not a directive',
    });

    expect(result.outcome).toBe('queued');
    expect((env.REVIEW_QUEUE as any).sent).toHaveLength(1);
  });
});
