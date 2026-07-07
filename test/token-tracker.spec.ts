import { describe, it, expect } from 'vitest';
import { TokenTracker } from '@server/core/token-tracker';

// Regression coverage for the subrequest-exhaustion incident (job bb9cf692...): the review
// workflow could burn through Cloudflare's per-invocation subrequest cap (Workers Free plan:
// 50 subrequests/invocation) without ever checking how much budget was left. TokenTracker
// already tracked a running count but exposed no way to ask "how much is safely left", so
// nothing consulted it before starting more concurrent work. These tests pin down the new
// remainingSafeBudget() accessor that review.ts and model.ts now use to throttle themselves.

describe('TokenTracker.remainingSafeBudget', () => {
  it('starts with the full margin below the hard cap available', () => {
    const tracker = new TokenTracker();
    // MAX_SUBREQUESTS (50) - SAFE_MARGIN (22) = 28, with nothing spent yet.
    expect(tracker.remainingSafeBudget()).toBe(28);
  });

  it('shrinks by exactly what has been spent so far', () => {
    const tracker = new TokenTracker();
    tracker.incrementSubrequests(10);
    expect(tracker.remainingSafeBudget()).toBe(18);

    tracker.incrementSubrequests(5);
    expect(tracker.remainingSafeBudget()).toBe(13);
  });

  it('never goes negative once spending exceeds the safe margin', () => {
    const tracker = new TokenTracker();
    tracker.incrementSubrequests(45);
    expect(tracker.remainingSafeBudget()).toBe(0);

    tracker.incrementSubrequests(100);
    expect(tracker.remainingSafeBudget()).toBe(0);
  });

  it('agrees with isNearLimit at the same threshold', () => {
    const tracker = new TokenTracker();
    tracker.incrementSubrequests(27);
    expect(tracker.isNearLimit()).toBe(false);
    expect(tracker.remainingSafeBudget()).toBeGreaterThan(0);

    tracker.incrementSubrequests(1);
    expect(tracker.isNearLimit()).toBe(true);
    expect(tracker.remainingSafeBudget()).toBe(0);
  });
});
