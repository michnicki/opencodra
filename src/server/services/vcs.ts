import type { AppBindings } from '../env';
import { GithubAdapter } from '../vcs/github';
import { BitbucketAdapter } from '../vcs/bitbucket';
import type { VcsProvider } from '../vcs/types';

/**
 * Typed placeholder for features the VcsService declares but does not yet implement. Currently
 * only the `forProvider({ provider: 'bitbucket' })` path throws this -- the only Bitbucket event
 * source is the webhook route (Wave 3), which always has a job row already and therefore reaches
 * VcsService via `forRepo`, not `forProvider`.
 *
 * The thrown class is exported so callers / tests can `instanceof NotImplementedError` to
 * distinguish "this branch is intentionally not yet wired" from a genuine error.
 */
export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotImplementedError';
  }
}

/**
 * The single branch point every VCS operation in `core/review.ts` dispatches through (FND-05),
 * structurally mirroring the `ModelService` strategy pattern in `services/model.ts` but shaped as
 * a factory (D-05) rather than an instantiable class: there is nothing to resolve/fallback across
 * per call the way models do -- the provider mapping is 1:1 per repo.
 *
 * Both entry points are `async` so that a real, potentially-rejecting provider/credential read
 * (Phase 4/5's Bitbucket adapter) never has to re-edit this highest-scrutiny seam later.
 */
export class VcsService {
  /**
   * Resolves the provider for an already-loaded job row (D-14, R-01 widening).
   *
   * Reads `job.repositoryVcsProvider` (a DB-derived value, NEVER request-derived; T-05-10):
   *   - 'bitbucket' -> `BitbucketAdapter.create(env, job, tracker)` -- the async factory reads +
   *     decrypts the per-repo credential. A rejection propagates upward, where the caller's
   *     lease-release try/catch (core/review.ts:388-394) absorbs it and releases the lease.
   *   - 'github' (default) -> `new GithubAdapter(env, job.installationId, tracker)`. Zero behavior
   *     change for the GitHub path; byte-identical to the prior implementation.
   */
  static async forRepo(
    env: AppBindings,
    // REV-C-3 / R-01: installationId is now nullable (Bitbucket rows carry null). The adapter
    // constructor still requires a string today; the Bitbucket branch lands in Wave 2 via the
    // GitHubAdapter-for-non-github rows guard. For now, a null installationId should never reach
    // this method (runReviewJob gates it via the R-02 widenings) -- pass through as '' defensively
    // so the typecheck stays clean while we wait for the Wave 2 adapter implementation.
    job: {
      installationId?: string | null;
      repositoryVcsProvider?: string | null;
      repositoryWorkspace?: string | null;
    },
    tracker?: { incrementSubrequests(count?: number): void },
  ): Promise<VcsProvider> {
    if (job.repositoryVcsProvider === 'bitbucket') {
      return BitbucketAdapter.create(env as AppBindings, job as Parameters<typeof BitbucketAdapter.create>[1], tracker);
    }
    return new GithubAdapter(env, job.installationId ?? '', tracker);
  }

  /**
   * The no-job-row entry point (Open Q2, D-03) for the two `resolveQueuedJob` sites that have
   * `env` + `installationId` + a known provider but no persisted job row yet. `tracker` is
   * intentionally OPTIONAL and OMITTED by both current callers -- they run before `runReviewJob`'s
   * `new TokenTracker()` exists.
   *
   * D-15: provider now widens to 'github' | 'bitbucket'. The 'bitbucket' branch throws a typed
   * `NotImplementedError` -- there is no live Bitbucket no-job-row path this phase (the only
   * Bitbucket event source is the webhook route in Wave 3, which always creates a job row before
   * the worker needs a provider).
   */
  static async forProvider(
    env: AppBindings,
    opts: { provider: 'github' | 'bitbucket'; installationId?: string },
    tracker?: { incrementSubrequests(count?: number): void },
  ): Promise<VcsProvider> {
    if (opts.provider === 'bitbucket') {
      throw new NotImplementedError('Bitbucket forProvider is not yet supported');
    }
    if (!opts.installationId) {
      throw new Error('VcsService.forProvider requires installationId for github');
    }
    return new GithubAdapter(env, opts.installationId, tracker);
  }
}