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
  // REV-M-5: optional job id used by the Bitbucket adapter's combined marker+summary comment
  // (REV-R-A). The GitHub adapter accepts it and ignores it -- the GitHub submitReview flow
  // composes a single createReview POST that does not need the job id embedded in the body. The
  // field is optional so existing GitHub call sites continue to type-check unchanged.
  jobIdHint?: string;
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

  /**
   * Per-adapter capability flags. REQUIRED (not optional like `labels?`) so every adapter MUST
   * declare it — this is the single extension point where future capability flags join the same
   * block, avoiding a per-flag interface refactor (D-09). `supportsMermaid` lets a later phase's
   * walkthrough formatter gate its Mermaid diagram per-provider (GitHub renders Mermaid in
   * markdown; Bitbucket Cloud does not). Inert this phase — no consumer reads it yet.
   */
  readonly capabilities: { readonly supportsMermaid: boolean };

  getPullRequest(owner: string, repo: string, prNumber: number): Promise<VcsPullRequest>;
  getPullRequestDiff(owner: string, repo: string, prNumber: number): Promise<string>;

  createStatusCheck(owner: string, repo: string, input: VcsCreateStatusCheckInput): Promise<{ ref: string }>;
  /**
   * Update an already-created status check.
   *
   * `ref` is PROVIDER-OPAQUE (REV-M-10): the adapter chooses how to interpret it. GitHub uses
   * numeric check_run_id (as a string); Bitbucket uses report_id string ('codra-review' for
   * both fresh and retry). For Bitbucket the build-status POST always uses key='codra-review'
   * regardless of `ref` -- `ref` is consumed only by the Code Insights PUT path.
   *
   * The implementation contract:
   *   - GitHubAdapter: `Number(ref)` -> numeric check_run_id; forwarded to `updateCheckRun`.
   *   - BitbucketAdapter: `ref` -> the report_id for the Code Insights PUT; build-status POST
   *     uses hardcoded key='codra-review'.
   */
  updateStatusCheck(owner: string, repo: string, ref: string, input: VcsUpdateStatusCheckInput): Promise<void>;

  submitReview(owner: string, repo: string, prNumber: number, input: VcsSubmitReviewInput): Promise<{ ref: string }>;
  findExistingReviewForCommit(owner: string, repo: string, prNumber: number, commitSha: string): Promise<{ ref: string } | null>;

  /**
   * Standalone (issue/PR-level) comment primitives. REQUIRED on every adapter (not optional like
   * `labels?`) -- both providers implement them (D-01). No consumer is wired this phase; the
   * methods are inert (D-06). The primitives are thin -- consumers own de-duplication, there is no
   * built-in dedup (D-04).
   *
   * The `ref` is PROVIDER-OPAQUE and self-encoding: the adapter alone interprets it, and a numeric
   * provider id must NEVER cross this seam into `core/` (D-01/D-02). GitHub's ref is the bare
   * comment id; Bitbucket packs the PR id with the comment id (e.g. `${prId}:${commentId}`) so a
   * persisted ref stays fully self-sufficient -- `editPrComment(owner, repo, ref, body)` mirrors
   * `updateStatusCheck(owner, repo, ref, input)` exactly, with NO separate `prNumber` argument (D-02).
   *
   * `editPrComment` returns `null` when the target comment no longer exists -- HTTP 404 OR 410 Gone
   * (amended D-05, review F3) -- identically on both providers, so a consumer re-posts with a plain
   * `if (!result)` branch rather than `try/catch`; any other status throws (existing
   * `GitHubError` / Bitbucket error patterns), and `core/` never inspects a raw HTTP status. Its
   * success return `{ ref }` mirrors the `findExistingReviewForCommit` nullable-return precedent.
   *
   * `listPrComments` author is `{ id, login }`: `id` is the IMMUTABLE provider id (GitHub numeric
   * user id as a string / Bitbucket `account_id`) used for authorization and bot self-filter
   * (NREG-02, Phase 11); `login` is the renameable `@mention` handle (GitHub `login` / Bitbucket
   * `nickname`) (D-03). `author.id` is ALWAYS non-empty -- a comment missing an immutable id is
   * OMITTED from the result rather than surfaced as `''` (review F5), so a consumer can trust it as
   * a self-filter key. The result is a SINGLE oldest-first page (GitHub `per_page=100` / Bitbucket
   * `pagelen=100`); a consumer needing the most-recent comments MUST sort newest-first or paginate
   * (cap + ordering caveat -- review F7).
   */
  createPrComment(owner: string, repo: string, prNumber: number, body: string): Promise<{ ref: string }>;
  editPrComment(owner: string, repo: string, ref: string, body: string): Promise<{ ref: string } | null>;
  listPrComments(owner: string, repo: string, prNumber: number): Promise<Array<{ ref: string; body: string; author: { id: string; login: string } }>>;

  /**
   * Post a provider-native THREADED reply under an existing PR comment (D-01, Phase 12). REQUIRED on
   * every adapter (not optional) -- both providers implement it (NREG-02). No consumer is wired this
   * phase; the method is inert until Part A (Plans 02/03) consumes it.
   *
   * `inReplyToRef` is the PROVIDER-OPAQUE ref of the ORIGINATING comment, exactly as carried on
   * `CommentContext.commentRef` -- the adapter alone interprets it, and a numeric provider id must
   * NEVER cross this seam into `core/` (mirrors the createPrComment/editPrComment contract above).
   *
   * Provider threading semantics differ, so the CALLER (not this method) decides threadability via
   * the payload `threadable` flag:
   *   - GitHubAdapter: threads ONLY an inline review comment via `in_reply_to` on
   *     POST /pulls/{n}/comments. A top-level ISSUE comment is NOT threadable on GitHub, so the
   *     caller falls back to `createPrComment` for those; `inReplyToRef` is the bare comment id.
   *   - BitbucketAdapter: threads BOTH general and inline comments via `parent:{id}` on
   *     POST /pullrequests/{n}/comments; `inReplyToRef` is the self-encoding `${prId}:${commentId}`.
   *
   * A malformed `inReplyToRef` is rejected BEFORE any HTTP request (GitHub canonical
   * positive-integer regex + Number.isSafeInteger; Bitbucket parsePrCommentRef, which also rejects a
   * ref whose encoded prId != the target prNumber). Returns the NEW comment's opaque `{ ref }`.
   */
  replyToPrComment(owner: string, repo: string, prNumber: number, body: string, inReplyToRef: string): Promise<{ ref: string }>;

  /**
   * Resolve an actor's effective permission on a repo for command authorization (CMD-08, D-06/D-07).
   *
   * `authorId` is the IMMUTABLE provider id (GitHub numeric user id as a string / Bitbucket
   * `account_id`) — authorization is ALWAYS decided on `authorId`, NEVER on a renameable username
   * (NREG-02). `authorLogin` is OPTIONAL and used ONLY to form the provider URL where the endpoint
   * needs a username in the path (GitHub `GET .../collaborators/{login}/permission`); the response's
   * immutable id is then re-verified against `authorId`.
   *
   * Returns the mapped union on success, or `null` on ANY resolution failure (403/404/network, a
   * login/id mismatch, or — on Bitbucket — the frequent case where a repository access token cannot
   * query permissions at all, A1). A `null` return means "could not resolve" so the caller fails
   * CLOSED: only a resolved 'admin'/'write' authorizes a state-changing command; 'read'/'none'/null
   * are unauthorized and silently ignored (D-07).
   *
   * NOTE (Bitbucket, A1): on Bitbucket this is a BEST-EFFORT diagnostic only — the AUTHORITATIVE
   * Bitbucket authorization is the per-repo allow-list of immutable account_ids evaluated in Plan 03
   * `authorizeActor` (config.review.interactive.commands.bitbucket_allowed_account_ids). A Bitbucket
   * `null` here means "defer to the allow-list", not "deny"; membership is NEVER mapped to 'write'.
   */
  getUserRepoPermission(
    owner: string,
    repo: string,
    authorId: string,
    authorLogin?: string,
  ): Promise<'admin' | 'write' | 'read' | 'none' | null>;

  /**
   * Resolve the bot's OWN immutable identity for the comment self-filter (Phase 11, CMD-07). Returns
   * the bot's immutable provider account id (GitHub bot-user numeric id as a string / Bitbucket
   * `account_id`) plus its optional login.
   *
   * Surfaced on the seam so the webhook-ingest dispatch layer (Plan 06) can build a
   * `BotIdentityResolver` from the already-constructed provider WITHOUT reaching into the private
   * underlying client — mirroring how `getUserRepoPermission` was exposed through the adapter. The
   * resolved id is the load-bearing echo-loop defense key (classifyComment self-filters on it before
   * any parse, D-03).
   */
  resolveBotUserIdentity(): Promise<{ accountId: string; login?: string }>;

  labels?: {
    ensure(owner: string, repo: string, name: string, color: string): Promise<void>;
    add(owner: string, repo: string, prNumber: number, labels: string[]): Promise<void>;
    removeIfPresent(owner: string, repo: string, prNumber: number, labels: string[]): Promise<void>;
  };
}
