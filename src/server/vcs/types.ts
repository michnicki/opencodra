// Provider-agnostic VCS contract. This module is the sibling of `models/types.ts` --
// a plain types module (no logic) that every per-provider adapter (`vcs/github.ts`,
// and a future `vcs/bitbucket.ts`) implements. Lives in `vcs/`, not `src/shared/`,
// because these shapes do not cross the worker/client boundary this phase.

/**
 * Flattened PR metadata. Deliberately NOT the nested `{ head: { sha, ref }, base: {...},
 * user: { login } }` shape GitHub's REST API returns (see `core/github.ts` `PullRequestRecord`)
 * -- the flatten is what stops GitHub's payload shape leaking into the shared contract (D-01).
 */
export type VcsPullRequest = {
  number: number;
  title: string | null;
  body: string | null;
  draft: boolean;
  headSha: string;
  headRef: string | null;
  baseSha: string;
  baseRef: string | null;
  authorLogin: string | null;
};

/**
 * Input for creating a status check. `headSha` is REQUIRED here because
 * `createStatusCheck` maps to `createCheckRun`, which needs it to anchor the check run to a
 * commit. Split from `VcsUpdateStatusCheckInput` (review finding 6, opencode MEDIUM) so the
 * update shape never carries a field its call sites don't have in scope.
 */
export type VcsCreateStatusCheckInput = {
  headSha: string;
  title: string;
  summary: string;
  // NO `status`/`conclusion` here: creation is always `in_progress` (the GitHub adapter's
  // `createCheckRun` hardcodes it, and Bitbucket's create is equivalently fixed). Advertising
  // them on the create input would be a silent no-op the adapter cannot honor (WR-02) --
  // callers that need a terminal state use `updateStatusCheck`/`VcsUpdateStatusCheckInput`.
};

/**
 * Input for updating an already-created status check. Deliberately has NO `headSha` --
 * `core/review.ts`'s four `updateStatusCheck` call sites (:703/:987/:1405/:1527) never have a
 * headSha in scope, so it must not leak into this type (review finding 6, opencode MEDIUM).
 */
export type VcsUpdateStatusCheckInput = {
  title: string;
  summary: string;
  status?: 'in_progress' | 'completed';
  conclusion?: 'success' | 'neutral' | 'failure' | 'cancelled';
};

/**
 * Field-for-field identical to `GitHubReviewComment` (`core/github.ts:89`), so GitHub's adapter
 * performs zero mapping (assumption A1). The concrete anchor/position naming is provider-agnostic
 * on purpose -- no GitHub-only required fields (Pitfall 1).
 */
export type VcsReviewComment = {
  path: string;
  position?: number;
  body: string;
};

export type VcsSubmitReviewInput = {
  commitSha: string;
  verdict: 'approve' | 'comment';
  summaryBody: string;
  comments: VcsReviewComment[];
};

/**
 * The provider-agnostic seam every later phase rides on (mirrors the `ModelService`/
 * `models/types.ts` strategy pattern). Status-check/review methods return an opaque
 * `{ ref: string }`, never a numeric id (D-01/D-02) -- Bitbucket's build-status API has no
 * server-assigned id to hand back. `labels` is OPTIONAL: Bitbucket Cloud has no native PR-labels
 * feature, so callers must feature-detect `if (vcs.labels)` rather than assume it (Pattern 2).
 */
export interface VcsProvider {
  readonly name: 'github' | 'bitbucket';

  getPullRequest(owner: string, repo: string, prNumber: number): Promise<VcsPullRequest>;
  getPullRequestDiff(owner: string, repo: string, prNumber: number): Promise<string>;

  createStatusCheck(owner: string, repo: string, input: VcsCreateStatusCheckInput): Promise<{ ref: string }>;
  updateStatusCheck(owner: string, repo: string, ref: string, input: VcsUpdateStatusCheckInput): Promise<void>;

  submitReview(owner: string, repo: string, prNumber: number, input: VcsSubmitReviewInput): Promise<{ ref: string }>;
  findExistingReviewForCommit(owner: string, repo: string, prNumber: number, commitSha: string): Promise<{ ref: string } | null>;

  labels?: {
    ensure(owner: string, repo: string, name: string, color: string): Promise<void>;
    add(owner: string, repo: string, prNumber: number, labels: string[]): Promise<void>;
    removeIfPresent(owner: string, repo: string, prNumber: number, labels: string[]): Promise<void>;
  };
}
