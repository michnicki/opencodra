import type { AppBindings } from '@server/env';
import { logger } from '@server/core/logger';
import { withTimeout } from '@server/core/timeout';
import type {
  CodeInsightsReport,
  CommitBuildStatus,
  PrComment,
} from '@shared/bitbucket';
import type { VcsPullRequest } from '@server/vcs/types';

// BB-01 deliberately mirrors the hand-rolled GitHub client: Workers-native fetch keeps the REST
// surface small and avoids an SDK. The methods below own Bitbucket-specific mappings for PR fields,
// comment anchors (REV-M-2), Code Insights/build status (D-10/D-11), and baseSha (REV-M-7).
const BITBUCKET_API_BASE_URL = 'https://api.bitbucket.org/2.0';
// Match GitHub's 30-second request cap so a single external call cannot consume a Worker invocation.
const BITBUCKET_TIMEOUT_MS = 30_000;

export class BitbucketError extends Error {
  constructor(
    public readonly status: number,
    // This raw response may contain provider detail. Pass the Error object through the structured
    // logger so its redaction policy applies; never log `body` directly (T-05-06).
    public readonly body: string,
    public readonly path: string,
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'BitbucketError';
  }

  // Structured logging and JSON.stringify(err) must never serialize the raw response `body`, which
  // can carry provider credentials or sensitive detail (T-05-06). `body` stays available to retry
  // logic internally; only its serialized form is suppressed here.
  toJSON() {
    return {
      name: this.name,
      status: this.status,
      path: this.path,
      message: this.message,
      retryAfterMs: this.retryAfterMs,
    };
  }
}

function retryAfterMs(response: Response) {
  const rawValue = response.headers.get('retry-after');
  if (!rawValue) {
    return undefined;
  }

  const seconds = Number(rawValue);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const retryAt = Date.parse(rawValue);
  if (!Number.isNaN(retryAt)) {
    return Math.max(0, retryAt - Date.now());
  }

  return undefined;
}

async function withRetry<T>(
  operation: string,
  fn: () => Promise<T>,
  maxRetries = 2,
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (error: any) {
      attempt += 1;
      const isRetryable =
        (error instanceof BitbucketError && (error.status === 429 || error.status >= 500)) ||
        error?.name === 'TimeoutError' ||
        String(error?.message ?? '').toLowerCase().includes('timeout');

      if (!isRetryable || attempt > maxRetries) {
        throw error;
      }

      const delay = error instanceof BitbucketError && error.retryAfterMs !== undefined
        ? error.retryAfterMs
        : Math.pow(2, attempt) * 1000;
      logger.warn(`Retrying Bitbucket operation ${operation} (attempt ${attempt}/${maxRetries}) in ${delay}ms`, {
        status: error instanceof BitbucketError ? error.status : undefined,
        error: error instanceof Error ? error.message : String(error),
      });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

type BitbucketPullRequestRecord = {
  id: number;
  title?: string | null;
  description?: string | null;
  draft?: boolean;
  source: {
    branch?: { name?: string | null };
    commit: { hash: string };
  };
  destination: {
    branch?: { name?: string | null };
    commit: { hash: string };
  };
  author?: { username?: string | null; display_name?: string | null };
};

type BitbucketCommentRecord = {
  id: number;
  content?: { raw?: string };
  inline?: {
    path: string;
    to?: number;
    from?: number;
  };
};

function repositoryPath(workspace: string, repoSlug: string) {
  return `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}`;
}

export class BitbucketClient {
  constructor(
    private readonly env: Pick<AppBindings, 'BOT_USERNAME'>,
    private readonly token: string,
    private readonly tracker?: { incrementSubrequests(count?: number): void },
  ) {}

  private async request(
    method: string,
    path: string,
    body?: unknown,
    accept = 'application/json',
  ): Promise<Response> {
    return withRetry(`${method} ${path}`, async () => {
      this.tracker?.incrementSubrequests(1);
      const response = await withTimeout(`Bitbucket ${method} ${path}`, BITBUCKET_TIMEOUT_MS, (signal) =>
        globalThis.fetch(`${BITBUCKET_API_BASE_URL}${path}`, {
          method,
          signal,
          headers: {
            Accept: accept,
            Authorization: `Bearer ${this.token}`,
            'User-Agent': this.env.BOT_USERNAME ?? 'codra-bot',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      );

      if (!response.ok) {
        const errorBody = await response.text();
        throw new BitbucketError(
          response.status,
          errorBody,
          path,
          `Bitbucket API ${method} ${path} failed with ${response.status}`,
          retryAfterMs(response),
        );
      }

      return response;
    });
  }

  async getPullRequest(workspace: string, repoSlug: string, prNumber: number): Promise<VcsPullRequest> {
    const path = `${repositoryPath(workspace, repoSlug)}/pullrequests/${prNumber}`;
    const response = await this.request('GET', path);
    const pullRequest = (await response.json()) as BitbucketPullRequestRecord;

    return {
      number: pullRequest.id,
      title: pullRequest.title ?? null,
      body: pullRequest.description ?? null,
      draft: pullRequest.draft ?? false,
      headSha: pullRequest.source.commit.hash,
      headRef: pullRequest.source.branch?.name ?? null,
      baseSha: pullRequest.destination.commit.hash,
      baseRef: pullRequest.destination.branch?.name ?? null,
      authorLogin: pullRequest.author?.username ?? pullRequest.author?.display_name ?? null,
    };
  }

  async getPullRequestDiff(workspace: string, repoSlug: string, prNumber: number): Promise<string> {
    const path = `${repositoryPath(workspace, repoSlug)}/pullrequests/${prNumber}/diff?context=3`;
    const response = await this.request('GET', path, undefined, 'text/plain');
    return response.text();
  }

  async listPullRequestComments(workspace: string, repoSlug: string, prNumber: number, pagelen = 100) {
    const path = `${repositoryPath(workspace, repoSlug)}/pullrequests/${prNumber}/comments?pagelen=${pagelen}`;
    const response = await this.request('GET', path);
    const page = (await response.json()) as { values?: BitbucketCommentRecord[] };

    return (page.values ?? []).map((comment) => ({
      id: comment.id,
      body: comment.content?.raw ?? '',
      inline: comment.inline,
    }));
  }

  async postPullRequestComment(
    workspace: string,
    repoSlug: string,
    prNumber: number,
    comment: PrComment,
  ): Promise<{ id: number }> {
    const path = `${repositoryPath(workspace, repoSlug)}/pullrequests/${prNumber}/comments`;
    // `line_type` is Codra's internal classification. Bitbucket's OpenAPI accepts only path and
    // to/from on the wire: removed lines anchor with `from`, while added/context lines use `to`.
    // Marker and summary comments carry content only and intentionally omit the inline object.
    const body = 'line_type' in comment
      ? {
          content: { raw: comment.content.raw },
          inline: comment.line_type === 'removed'
            ? { path: comment.path, from: comment.line }
            : { path: comment.path, to: comment.line },
        }
      : { content: { raw: comment.content.raw } };
    const response = await this.request('POST', path, body);
    return (await response.json()) as { id: number };
  }

  async approvePullRequest(workspace: string, repoSlug: string, prNumber: number): Promise<void> {
    const path = `${repositoryPath(workspace, repoSlug)}/pullrequests/${prNumber}/approve`;
    await this.request('POST', path);
  }

  async upsertCodeInsightsReport(
    workspace: string,
    repoSlug: string,
    commit: string,
    report: CodeInsightsReport,
  ): Promise<void> {
    const path = `${repositoryPath(workspace, repoSlug)}/commit/${encodeURIComponent(commit)}/reports/codra-review`;
    await this.request('PUT', path, report);
  }

  async postCommitBuildStatus(
    workspace: string,
    repoSlug: string,
    commit: string,
    status: CommitBuildStatus,
  ): Promise<void> {
    const path = `${repositoryPath(workspace, repoSlug)}/commit/${encodeURIComponent(commit)}/statuses/build`;
    await this.request('POST', path, status);
  }
}
