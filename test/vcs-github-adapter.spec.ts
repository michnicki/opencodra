import { afterEach, describe, expect, it, vi } from 'vitest';
import { GithubAdapter } from '@server/vcs/github';
import { GitHubService } from '@server/services/github';
import { TokenTracker } from '@server/core/token-tracker';
import { createTestEnv, seedInstallationToken } from './helpers';
import { installGitHubFetchMock } from './github-fetch-mock';

const OWNER = 'test-owner';
const REPO = 'test-repo';
const PR_NUMBER = 42;
const INSTALLATION_ID = '123456';

function buildFixtures(overrides: Partial<Parameters<typeof installGitHubFetchMock>[0]> = {}) {
  return {
    owner: OWNER,
    repo: REPO,
    prNumber: PR_NUMBER,
    pull: {
      number: PR_NUMBER,
      title: 'Test PR',
      body: 'Test body',
      draft: false,
      head: { sha: 'headsha1234567890', ref: 'feature-branch' },
      base: { sha: 'basesha1234567890', ref: 'main' },
      user: { login: 'author-login' },
    },
    diff: 'diff --git a/file.ts b/file.ts\n@@ -1 +1 @@\n-old\n+new\n',
    ...overrides,
  };
}

describe('GithubAdapter (VcsProvider mapping)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('flattens the nested PR shape into a flat VcsPullRequest', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    const { restore } = installGitHubFetchMock(buildFixtures());

    try {
      const adapter = new GithubAdapter(env, INSTALLATION_ID);
      const pr = await adapter.getPullRequest(OWNER, REPO, PR_NUMBER);

      expect(pr).toEqual({
        number: PR_NUMBER,
        title: 'Test PR',
        body: 'Test body',
        draft: false,
        headSha: 'headsha1234567890',
        headRef: 'feature-branch',
        baseSha: 'basesha1234567890',
        baseRef: 'main',
        authorLogin: 'author-login',
      });
      // Not the nested GitHub shape.
      expect(pr).not.toHaveProperty('head');
      expect(pr).not.toHaveProperty('base');
      expect(pr).not.toHaveProperty('user');
    } finally {
      restore();
    }
  });

  it('round-trips the id<->ref conversion across createStatusCheck/updateStatusCheck', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    const { calls, restore } = installGitHubFetchMock(buildFixtures());

    try {
      const adapter = new GithubAdapter(env, INSTALLATION_ID);
      const { ref } = await adapter.createStatusCheck(OWNER, REPO, {
        headSha: 'headsha1234567890',
        title: 'Review queued',
        summary: 'Codra is reviewing this PR',
      });

      // installGitHubFetchMock's check-runs POST always returns { id: 9001 }.
      expect(ref).toBe('9001');
      expect(Number(ref)).toBe(9001);

      await adapter.updateStatusCheck(OWNER, REPO, ref, {
        title: 'Review complete',
        summary: 'No issues found',
        status: 'completed',
        conclusion: 'success',
      });

      const patchCall = calls.find((call) => call.method === 'PATCH' && call.path.includes('/check-runs/'));
      expect(patchCall?.path).toBe(`/repos/${OWNER}/${REPO}/check-runs/${Number(ref)}`);
    } finally {
      restore();
    }
  });

  it('maps verdict to a GitHub review event and returns an opaque ref', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    const { calls, restore } = installGitHubFetchMock(buildFixtures({ reviewResponses: [{ status: 200, id: 777 }] }));

    try {
      const adapter = new GithubAdapter(env, INSTALLATION_ID);
      const { ref } = await adapter.submitReview(OWNER, REPO, PR_NUMBER, {
        commitSha: 'headsha1234567890',
        verdict: 'approve',
        summaryBody: 'Looks good',
        comments: [],
      });

      expect(ref).toBe('777');
      const reviewPost = calls.find(
        (call) => call.method === 'POST' && call.path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/reviews`,
      );
      expect(reviewPost?.body.event).toBe('APPROVE');
    } finally {
      restore();
    }
  });

  it('maps a comment verdict to the COMMENT event', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    const { calls, restore } = installGitHubFetchMock(buildFixtures());

    try {
      const adapter = new GithubAdapter(env, INSTALLATION_ID);
      await adapter.submitReview(OWNER, REPO, PR_NUMBER, {
        commitSha: 'headsha1234567890',
        verdict: 'comment',
        summaryBody: 'Some notes',
        comments: [],
      });

      const reviewPost = calls.find(
        (call) => call.method === 'POST' && call.path === `/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/reviews`,
      );
      expect(reviewPost?.body.event).toBe('COMMENT');
    } finally {
      restore();
    }
  });

  // installGitHubFetchMock returns [] for the review-list lookup (github-fetch-mock.ts:88), so it
  // cannot prove the botLogin argument over the wire (review finding 3). Instead, spy on
  // GitHubService.prototype.findBotReviewForCommit directly and assert the argument the adapter
  // passes in equals env.BOT_USERNAME.
  it('injects env.BOT_USERNAME into findExistingReviewForCommit', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    const spy = vi.spyOn(GitHubService.prototype, 'findBotReviewForCommit').mockResolvedValue(null);

    const adapter = new GithubAdapter(env, INSTALLATION_ID);
    const result = await adapter.findExistingReviewForCommit(OWNER, REPO, PR_NUMBER, 'headsha1234567890');

    expect(result).toBeNull();
    expect(spy).toHaveBeenCalledWith(OWNER, REPO, PR_NUMBER, 'headsha1234567890', env.BOT_USERNAME);
  });

  it('returns a ref when an existing bot review is found', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    vi.spyOn(GitHubService.prototype, 'findBotReviewForCommit').mockResolvedValue({ id: 555 });

    const adapter = new GithubAdapter(env, INSTALLATION_ID);
    const result = await adapter.findExistingReviewForCommit(OWNER, REPO, PR_NUMBER, 'headsha1234567890');

    expect(result).toEqual({ ref: '555' });
  });

  it('forwards the tracker into GitHubService so the subrequest budget is preserved', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    const { restore } = installGitHubFetchMock(buildFixtures());
    const tracker = new TokenTracker();

    try {
      expect(tracker.getSubrequestCount()).toBe(0);
      const adapter = new GithubAdapter(env, INSTALLATION_ID, tracker);
      await adapter.getPullRequest(OWNER, REPO, PR_NUMBER);

      // The adapter did not drop the tracker -- GitHubClient increments it internally for both
      // the installation-token lookup and the PR fetch (Pitfall 1).
      expect(tracker.getSubrequestCount()).toBeGreaterThan(0);
    } finally {
      restore();
    }
  });

  it('delegates labels.ensure/add/removeIfPresent to the corresponding GitHubService calls', async () => {
    const env = createTestEnv();
    await seedInstallationToken(env, INSTALLATION_ID);
    const { calls, restore } = installGitHubFetchMock(buildFixtures());

    try {
      const adapter = new GithubAdapter(env, INSTALLATION_ID);
      expect(adapter.labels).toBeDefined();

      await adapter.labels!.ensure(OWNER, REPO, 'codra-reviewed', '00ff00');
      await adapter.labels!.add(OWNER, REPO, PR_NUMBER, ['codra-reviewed']);
      await adapter.labels!.removeIfPresent(OWNER, REPO, PR_NUMBER, ['codra-reviewed']);

      expect(calls.some((call) => call.method === 'POST' && call.path === `/repos/${OWNER}/${REPO}/labels`)).toBe(true);
      expect(
        calls.some(
          (call) => call.method === 'POST' && call.path === `/repos/${OWNER}/${REPO}/issues/${PR_NUMBER}/labels`,
        ),
      ).toBe(true);
      expect(
        calls.some(
          (call) =>
            call.method === 'DELETE' &&
            call.path === `/repos/${OWNER}/${REPO}/issues/${PR_NUMBER}/labels/codra-reviewed`,
        ),
      ).toBe(true);
    } finally {
      restore();
    }
  });
});
