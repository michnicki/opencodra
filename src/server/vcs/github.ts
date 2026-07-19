import { GitHubService } from '../services/github';
import type { AppBindings } from '../env';
import type {
  VcsCreateStatusCheckInput,
  VcsProvider,
  VcsPullRequest,
  VcsSubmitReviewInput,
  VcsUpdateStatusCheckInput,
} from './types';

/**
 * Wraps the existing, unchanged `GitHubService` behind the provider-agnostic `VcsProvider`
 * interface. Delegation ONLY -- no new REST logic.
 *
 * Imports `GitHubService` (NOT `GitHubClient`) from '../services/github' -- this exact module
 * path is load-bearing (Pitfall 3, review finding 5): three of the six protected specs
 * (review-flow, async-batch-review, review-subrequest-completion) `vi.mock('@server/services/github')`
 * and need the adapter to construct `GitHubService` through that module for the mock to keep
 * intercepting; pr-review-pipeline runs the REAL `GitHubClient` via `installGitHubFetchMock` and
 * stays green because the `GitHubService` -> `GitHubClient` delegation is unchanged.
 */
export class GithubAdapter implements VcsProvider {
  readonly name = 'github' as const;
  // GitHub renders Mermaid fenced code blocks in markdown, so the walkthrough formatter may emit a
  // Mermaid diagram for GitHub PRs (D-09). Required member on VcsProvider; inert this phase.
  readonly capabilities = { supportsMermaid: true } as const;
  private gh: GitHubService;

  constructor(
    private env: AppBindings,
    installationId: string,
    tracker?: { incrementSubrequests(count?: number): void },
  ) {
    // tracker MUST be forwarded -- it's an optional param on GitHubService's constructor, so
    // dropping it is silent: the subrequest budget regresses with no compile error (Pitfall 1).
    this.gh = new GitHubService(env, installationId, tracker);
  }

  async getPullRequest(owner: string, repo: string, prNumber: number): Promise<VcsPullRequest> {
    const pr = await this.gh.getPullRequest(owner, repo, prNumber);
    return {
      number: pr.number,
      title: pr.title,
      body: pr.body,
      draft: pr.draft,
      headSha: pr.head.sha,
      headRef: pr.head.ref,
      baseSha: pr.base.sha,
      baseRef: pr.base.ref,
      authorLogin: pr.user?.login ?? null,
    };
  }

  async getPullRequestDiff(owner: string, repo: string, prNumber: number): Promise<string> {
    return this.gh.getPullRequestDiff(owner, repo, prNumber);
  }

  async createStatusCheck(
    owner: string,
    repo: string,
    input: VcsCreateStatusCheckInput,
  ): Promise<{ ref: string }> {
    const { id } = await this.gh.createCheckRun(owner, repo, {
      headSha: input.headSha,
      title: input.title,
      summary: input.summary,
    });
    // Validate the id at the adapter boundary before stringifying (WR-04). `createCheckRun`
    // casts its response with an unchecked `as { id: number }`, so a body without a numeric `id`
    // (API change, error envelope that still parsed) would otherwise produce `String(undefined)`
    // -> "undefined" -> `Number("undefined")` -> NaN written into check_run_id at the call site.
    // `typeof NaN === 'number'`, so a NaN slips past a bare typeof check and stringifies to "NaN";
    // require a finite number to catch that too. Fail loudly at the seam instead.
    if (typeof id !== 'number' || !Number.isFinite(id)) {
      throw new Error(`createCheckRun returned a non-numeric id for ${owner}/${repo}: ${String(id)}`);
    }
    // id -> ref at the adapter boundary (D-02); the numeric column stays canonical.
    return { ref: String(id) };
  }

  async updateStatusCheck(
    owner: string,
    repo: string,
    ref: string,
    input: VcsUpdateStatusCheckInput,
  ): Promise<void> {
    // ref -> id at the adapter boundary (D-02). Mirror the create-side WR-04 guard: a corrupt
    // check_run_id (e.g. the round-trip of a prior "undefined"/"NaN" stringify) would make
    // `Number(ref)` NaN and build a `/check-runs/NaN` request. Reject non-finite refs at the seam.
    const checkRunId = Number(ref);
    if (!Number.isFinite(checkRunId)) {
      throw new Error(`updateStatusCheck received a non-numeric ref for ${owner}/${repo}: ${String(ref)}`);
    }
    await this.gh.updateCheckRun(owner, repo, checkRunId, {
      title: input.title,
      summary: input.summary,
      status: input.status,
      conclusion: input.conclusion,
    });
  }

  async submitReview(
    owner: string,
    repo: string,
    prNumber: number,
    input: VcsSubmitReviewInput,
  ): Promise<{ ref: string }> {
    // Relocated toReviewEvent (formerly services/formatter.ts:6-8).
    // REV-M-5: `jobIdHint` is intentionally IGNORED here -- the GitHub submitReview flow composes
    // a single createReview POST that does not embed the job id in its body. The field exists on
    // VcsSubmitReviewInput so the Bitbucket adapter (REV-R-A) can use it for its combined
    // marker+summary comment. Reference it once so the linter doesn't flag an unused parameter.
    void input.jobIdHint;
    const event = input.verdict === 'approve' ? ('APPROVE' as const) : ('COMMENT' as const);
    const { id } = await this.gh.createReview(owner, repo, prNumber, {
      commitSha: input.commitSha,
      event,
      body: input.summaryBody,
      comments: input.comments,
    });
    // Mirror the createStatusCheck WR-04 guard: `createReview` casts its body with an unchecked
    // `as { id: number }`, so a non-numeric/NaN id would otherwise stringify into a corrupt ref.
    if (typeof id !== 'number' || !Number.isFinite(id)) {
      throw new Error(`createReview returned a non-numeric id for ${owner}/${repo}#${prNumber}: ${String(id)}`);
    }
    return { ref: String(id) };
  }

  async findExistingReviewForCommit(
    owner: string,
    repo: string,
    prNumber: number,
    commitSha: string,
  ): Promise<{ ref: string } | null> {
    // The interface omits botLogin; the adapter injects env.BOT_USERNAME internally (Pitfall 5).
    const found = await this.gh.findBotReviewForCommit(owner, repo, prNumber, commitSha, this.env.BOT_USERNAME);
    return found ? { ref: String(found.id) } : null;
  }

  async createPrComment(
    owner: string,
    repo: string,
    prNumber: number,
    body: string,
  ): Promise<{ ref: string }> {
    const { id } = await this.gh.createIssueComment(owner, repo, prNumber, body);
    // WR-04 finite-guard copied from submitReview (:123-125): createIssueComment casts its body
    // with an unchecked `as { id: number }`, so a non-numeric/NaN id would otherwise stringify into
    // a corrupt ref. Fail loudly at the seam.
    if (typeof id !== 'number' || !Number.isFinite(id)) {
      throw new Error(`createIssueComment returned a non-numeric id for ${owner}/${repo}#${prNumber}: ${String(id)}`);
    }
    // GitHub ref is the bare comment id (D-02).
    return { ref: String(id) };
  }

  async editPrComment(
    owner: string,
    repo: string,
    ref: string,
    body: string,
  ): Promise<{ ref: string } | null> {
    // Validate the ref STRICTLY (review F4): Number.isFinite(Number(ref)) is too weak -- it accepts
    // '', '  ', '1.5', '1e3', '-1', '0'. Require a canonical positive safe-integer string (no leading
    // zeros, no sign, no decimal/exponent, no whitespace, > 0) BEFORE any request. No prNumber arg (D-02).
    if (!/^[1-9][0-9]*$/.test(ref) || !Number.isSafeInteger(Number(ref))) {
      throw new Error(`editPrComment received a malformed ref for ${owner}/${repo}: ${JSON.stringify(ref)}`);
    }
    const commentId = Number(ref);
    const result = await this.gh.updateIssueComment(owner, repo, commentId, body);
    // null flows straight through from the client for both 404 and 410 (amended D-05 / review F3);
    // the adapter never inspects a raw HTTP status.
    // WR-01: echo the already-validated input ref instead of re-deriving from `result.id`.
    // `updateIssueComment` casts its body with an unchecked `as { id: number }`, so a malformed/absent
    // id would otherwise stringify into a corrupt ref ("undefined"/"NaN") that gets persisted and
    // breaks the next edit. `ref` was validated as a canonical positive safe-integer above; echoing
    // it matches the Bitbucket sibling and needs no extra guard.
    return result ? { ref } : null;
  }

  async listPrComments(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<Array<{ ref: string; body: string; author: { id: string; login: string } }>> {
    const items = await this.gh.listIssueComments(owner, repo, prNumber);
    const results: Array<{ ref: string; body: string; author: { id: string; login: string } }> = [];
    for (const c of items) {
      // OMIT any comment whose author identity is missing/invalid (review F5): a false '' /
      // 'undefined' id would defeat the Phase 11 self-filter, which requires a non-null immutable id
      // (core/bot-identity.ts:105-108). Skip rather than emit a forgeable empty id.
      if (!c.user || typeof c.user.id !== 'number' || !Number.isFinite(c.user.id)) {
        continue;
      }
      // IN-01: guard c.id the same way as author.id -- the list is an unchecked `as`-cast, so a
      // non-numeric/NaN comment id would stringify into a corrupt ref. Skip such rows.
      if (typeof c.id !== 'number' || !Number.isFinite(c.id)) {
        continue;
      }
      // author.id is String(c.user.id), the immutable numeric user id, never login (NREG-02, D-03).
      // login is best-effort (only author.id is load-bearing); default to '' so it is never
      // undefined, matching the Bitbucket sibling's `?? ''` normalization (IN-01).
      results.push({ ref: String(c.id), body: c.body, author: { id: String(c.user.id), login: c.user.login ?? '' } });
    }
    return results;
  }

  labels = {
    ensure: (owner: string, repo: string, name: string, color: string) =>
      this.gh.ensureLabel(owner, repo, name, color),
    add: (owner: string, repo: string, prNumber: number, labels: string[]) =>
      this.gh.addIssueLabels(owner, repo, prNumber, labels),
    removeIfPresent: (owner: string, repo: string, prNumber: number, labels: string[]) =>
      this.gh.removeIssueLabelsIfPresent(owner, repo, prNumber, labels),
  };
}
