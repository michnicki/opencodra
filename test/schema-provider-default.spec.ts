import { describe, expect, it } from 'vitest';
import { reviewJobMessageSchema } from '@shared/schema';

describe('reviewJobMessageSchema provider default (NREG-03/FND-03)', () => {
  it('parses a jobId-style pre-migration message (no provider field) and resolves provider to github', () => {
    // Pre-migration fixture: every field a real ReviewJobMessage produced by code that predates
    // this phase would have had, deliberately omitting `provider` since that key did not exist
    // before this phase.
    const preMigrationFixture = {
      jobId: '11111111-1111-4111-8111-111111111111',
      deliveryId: 'delivery-pre-migration-1',
    };

    const result = reviewJobMessageSchema.safeParse(preMigrationFixture);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.provider).toBe('github');
    }
  });

  it('round-trips an explicit provider: bitbucket value unchanged', () => {
    const bitbucketFixture = {
      jobId: '22222222-2222-4222-8222-222222222222',
      deliveryId: 'delivery-bitbucket-1',
      provider: 'bitbucket',
    };

    const result = reviewJobMessageSchema.safeParse(bitbucketFixture);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.provider).toBe('bitbucket');
    }
  });

  it('parses an event-only pre-migration message (no jobId, no provider) and resolves provider to github', () => {
    // Cross-AI review consensus finding: real pre-migration producers emit this event-only shape
    // for non-job-producing events -- see src/server/routes/webhook.ts:125's
    // `REVIEW_QUEUE.send({ deliveryId, eventName, requestId })` -- not just the jobId-style shape
    // above. `provider` is deliberately absent since it did not exist before this phase.
    const eventOnlyFixture = {
      deliveryId: 'delivery-event-only-1',
      eventName: 'pull_request',
    };

    const result = reviewJobMessageSchema.safeParse(eventOnlyFixture);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.provider).toBe('github');
    }
  });

  it('fails validation for an unknown provider value outside the closed vocabulary', () => {
    const gitlabFixture = {
      jobId: '33333333-3333-4333-8333-333333333333',
      deliveryId: 'delivery-gitlab-1',
      provider: 'gitlab',
    };

    const result = reviewJobMessageSchema.safeParse(gitlabFixture);

    expect(result.success).toBe(false);
  });
});
