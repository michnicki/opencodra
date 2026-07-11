import { describe, expect, it } from 'vitest';
import { budgetAwareFileLimit } from '@server/core/review';
import { TokenTracker } from '@server/core/token-tracker';
import { REVIEW_CONCURRENCY_LIMITS, reviewConcurrencyLevels } from '@shared/schema';

// Regression guard for the "concurrency slider is dead above medium" incident: the per-chunk
// budget cap must NOT silently override the user's configured concurrency at a healthy budget.
// These assertions exercise the REAL TokenTracker (so MAX_SUBREQUESTS / SAFE_MARGIN are in play)
// and the REAL REVIEW_CONCURRENCY_LIMITS, so bumping SAFE_MARGIN or ESTIMATED_SUBREQUESTS_PER_FILE
// back into a slider-defeating range fails this test.

const maxLevel = Math.max(...reviewConcurrencyLevels.map((level) => REVIEW_CONCURRENCY_LIMITS[level]));

describe('budgetAwareFileLimit', () => {
  it('honors every configured concurrency level at a fresh budget', () => {
    const fresh = new TokenTracker().remainingSafeBudget();
    for (const level of reviewConcurrencyLevels) {
      const configured = REVIEW_CONCURRENCY_LIMITS[level];
      expect(budgetAwareFileLimit(fresh, configured)).toBe(configured);
    }
  });

  it('still honors the highest level after the getPullRequest preamble spends a few subrequests', () => {
    const tracker = new TokenTracker();
    tracker.incrementSubrequests(3); // token read + getPullRequest + a little slack
    expect(budgetAwareFileLimit(tracker.remainingSafeBudget(), maxLevel)).toBe(maxLevel);
  });

  it('throttles below the configured level only once the budget has actually been eaten into', () => {
    // Deep into a troubled invocation the cap should shrink to protect the 50-subrequest ceiling.
    expect(budgetAwareFileLimit(4, maxLevel)).toBe(0);
    expect(budgetAwareFileLimit(0, maxLevel)).toBe(0);
    expect(budgetAwareFileLimit(10, maxLevel)).toBeLessThan(maxLevel);
  });

  it('never exceeds the configured level even with a huge budget', () => {
    expect(budgetAwareFileLimit(10_000, 2)).toBe(2);
  });
});
