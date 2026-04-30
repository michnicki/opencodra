export const supportedGitHubWebhookEvents = ['pull_request', 'issue_comment'] as const;

export type GitHubWebhookEventName = typeof supportedGitHubWebhookEvents[number];

export function isSupportedGitHubWebhookEvent(eventName: string): eventName is GitHubWebhookEventName {
  return (supportedGitHubWebhookEvents as readonly string[]).includes(eventName);
}

export type PullRequestWebhookPayload = {
  action: 'opened' | 'synchronize' | 'ready_for_review' | 'reopened' | 'closed';
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
