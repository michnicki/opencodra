/**
 * Shared throttling/timeout policy for outbound model calls.
 *
 * Two hard Cloudflare Workers Free-plan constraints shape everything here:
 *
 * 1. Each Worker invocation may have at most SIX connections simultaneously waiting for
 *    response headers. Anything beyond that (fetch, AI binding, KV, Hyperdrive) is silently
 *    QUEUED by the runtime -- it does not error, it just doesn't start. A model call that sits
 *    queued behind other long-running model calls will burn its own client-side timeout without
 *    the request ever being dispatched, which shows up in logs as a provider "timing out" at
 *    exactly the configured timeout on every attempt.
 * 2. 50 subrequests per invocation, so retries are expensive and every queued-then-timed-out
 *    call is a wasted subrequest.
 */

/** Base wall-clock budget for a model call reviewing a small diff. Successful review calls in
 * production land in the ~10-50s range; anything slower on a small prompt is almost always a
 * stuck/overloaded model, so fail over to the next model quickly instead of stalling the chunk. */
export const MODEL_TIMEOUT_BASE_MS = 45_000;
/** Extra time granted per diff line beyond MODEL_TIMEOUT_FREE_LINES -- large diffs legitimately
 * need longer generations. */
export const MODEL_TIMEOUT_PER_LINE_MS = 100;
/** Diff lines included in the base budget before per-line scaling kicks in. */
export const MODEL_TIMEOUT_FREE_LINES = 100;
/** Ceiling regardless of diff size; keeps a single call well under the workflow's 15-minute
 * step timeout even with several fallbacks. */
export const MODEL_TIMEOUT_MAX_MS = 120_000;

/**
 * Wall-clock timeout for one model call, scaled by the size of the (already truncated) diff
 * the model has to review. Small diffs fail over fast; large diffs get up to 2 minutes.
 */
export function adaptiveModelTimeoutMs(diffLineCount: number | null | undefined): number {
  const lines = typeof diffLineCount === 'number' && Number.isFinite(diffLineCount) ? Math.max(0, diffLineCount) : 0;
  const scaled = MODEL_TIMEOUT_BASE_MS + Math.max(0, lines - MODEL_TIMEOUT_FREE_LINES) * MODEL_TIMEOUT_PER_LINE_MS;
  return Math.min(MODEL_TIMEOUT_MAX_MS, scaled);
}

/**
 * Max model calls in flight at once for a single invocation. Kept below the runtime's
 * 6-connection cap so short-lived KV/Hyperdrive/GitHub requests issued by concurrent file
 * reviews still have free connection slots and model calls are never queued behind each other
 * by the runtime (queued calls burn their timeout without ever being dispatched).
 */
export const MAX_CONCURRENT_MODEL_CALLS = 3;

/**
 * Tiny FIFO semaphore. Callers wait *before* their provider timeout starts, so waiting for a
 * slot never eats into a model call's own time budget.
 */
export class ModelCallGate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit = MAX_CONCURRENT_MODEL_CALLS) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release() {
    // Hand the slot directly to the next waiter (active count unchanged) so a newly arriving
    // caller can't sneak in between the release and the waiter resuming.
    const next = this.waiters.shift();
    if (next) {
      next();
    } else {
      this.active--;
    }
  }
}
