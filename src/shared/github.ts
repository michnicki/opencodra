export type GitHubWebhookEventName = 'pull_request' | 'issue_comment';

export type PullRequestWebhookPayload = {
  action: 'opened' | 'synchronize' | 'ready_for_review';
  installation?: { id: number };
  repository: {
    owner: { login: string };
    name: string;
  };
  pull_request: {
    number: number;
    title: string;
    user: { login: string };
    head: { sha: string; ref: string };
    base: { sha: string; ref: string };
    draft: boolean;
    body: string | null;
  };
};

export type IssueCommentWebhookPayload = {
  action: 'created';
  installation?: { id: number };
  repository: {
    owner: { login: string };
    name: string;
  };
  issue: {
    number: number;
    pull_request?: {
      url: string;
    };
  };
  comment: {
    body: string;
  };
};

export type GitHubWebhookPayload = PullRequestWebhookPayload | IssueCommentWebhookPayload;
