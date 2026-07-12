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
    // Fail loudly at the seam instead.
    if (typeof id !== 'number') {
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
    // ref -> id at the adapter boundary (D-02).
    await this.gh.updateCheckRun(owner, repo, Number(ref), {
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
    const event = input.verdict === 'approve' ? ('APPROVE' as const) : ('COMMENT' as const);
    const { id } = await this.gh.createReview(owner, repo, prNumber, {
      commitSha: input.commitSha,
      event,
      body: input.summaryBody,
      comments: input.comments,
    });
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

  labels = {
    ensure: (owner: string, repo: string, name: string, color: string) =>
      this.gh.ensureLabel(owner, repo, name, color),
    add: (owner: string, repo: string, prNumber: number, labels: string[]) =>
      this.gh.addIssueLabels(owner, repo, prNumber, labels),
    removeIfPresent: (owner: string, repo: string, prNumber: number, labels: string[]) =>
      this.gh.removeIssueLabelsIfPresent(owner, repo, prNumber, labels),
  };
}
