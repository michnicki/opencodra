import type { AppBindings } from '../env';
import { GithubAdapter } from '../vcs/github';
import type { VcsProvider } from '../vcs/types';

/**
 * The single branch point every VCS operation in `core/review.ts` dispatches through (FND-05),
 * structurally mirroring the `ModelService` strategy pattern in `services/model.ts` but shaped as
 * a factory (D-05) rather than an instantiable class: there is nothing to resolve/fallback across
 * per call the way models do -- the provider mapping is 1:1 per repo.
 *
 * Both entry points are `async` now so that a real, potentially-rejecting provider/credential read
 * (Phase 4/5's Bitbucket adapter) never has to re-edit this highest-scrutiny seam later. This
 * phase, however, they are NON-THROWING (review finding 4): the body only constructs a
 * `GithubAdapter` synchronously-in-effect, with no `await` on a fetch/DB read that could reject --
 * so making the branch point async introduces no lease-leak surface in `runReviewJob`'s
 * pre-try-block construction (`core/review.ts:382`).
 */
export class VcsService {
  /**
   * Resolves the provider for an already-loaded job row. Per the recorded Open Q1 decision this
   * returns a GitHub-wrapping adapter UNCONDITIONALLY this phase -- every repo is 'github'
   * post-Phase-1, so there is no `vcs_provider` read here (that would be premature scope: no
   * db/jobs.ts or jobSummarySchema change is needed to satisfy this phase's criteria).
   *
   * NON-THROWING invariant (review finding 4): a real, potentially-rejecting provider/credential
   * read is deferred to Phase 5, and when added it MUST live inside (or have its rejection handled
   * by) the lease-release try/catch in `runReviewJob` -- not here, unguarded, before the lease is
   * even claimed's try block begins.
   */
  static async forRepo(
    env: AppBindings,
    job: { installationId: string },
    tracker?: { incrementSubrequests(count?: number): void },
  ): Promise<VcsProvider> {
    return new GithubAdapter(env, job.installationId, tracker);
  }

  /**
   * The no-job-row entry point (Open Q2, D-03) for the two `resolveQueuedJob` sites that have
   * `env` + `installationId` + a known provider ('github') but no persisted job row yet. `tracker`
   * is intentionally OPTIONAL and OMITTED by both current callers -- they run before
   * `runReviewJob`'s `new TokenTracker()` exists, and today's raw `new GitHubClient(env,
   * installationId)` construction at those sites has no tracker either (finding 8, zero-behavior-
   * change).
   */
  static async forProvider(
    env: AppBindings,
    opts: { provider: 'github'; installationId: string },
    tracker?: { incrementSubrequests(count?: number): void },
  ): Promise<VcsProvider> {
    return new GithubAdapter(env, opts.installationId, tracker);
  }
}
