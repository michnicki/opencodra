import { afterEach, describe, expect, it, vi } from 'vitest';
import { BitbucketAdapter } from '@server/vcs/bitbucket';
import { BitbucketClient } from '@server/core/bitbucket';
import { parseUnifiedDiff } from '@server/core/diff';
import { createTestEnv } from './helpers';
import { installBitbucketFetchMock } from './bitbucket-fetch-mock';
import type { VcsSubmitReviewInput } from '@server/vcs/types';

const WORKSPACE = 'acme';
const REPO = 'backend';
const PR_NUMBER = 42;
const COMMIT_SHA = 'head123';
const HEAD_SHA = COMMIT_SHA;

function buildJobFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-bb-1',
    owner: WORKSPACE,
    repo: REPO,
    prNumber: PR_NUMBER,
    commitSha: COMMIT_SHA,
    headSha: HEAD_SHA,
    installationId: null,
    repositoryVcsProvider: 'bitbucket',
    repositoryWorkspace: WORKSPACE,
    ...overrides,
  } as const;
}

// buildAdapter directly constructs an adapter with a stubbed client (the credential-read path is
// covered in test/vcs-service.spec.ts; this spec exercises the adapter's per-method contract).
type AdapterHandle = {
  adapter: BitbucketAdapter;
  client: BitbucketClient;
  env: ReturnType<typeof createTestEnv>;
  tracker: { incrementSubrequests: ReturnType<typeof vi.fn> };
};

function buildAdapter(env: ReturnType<typeof createTestEnv> = createTestEnv()): AdapterHandle {
  const tracker = { incrementSubrequests: vi.fn() };
  const client = new BitbucketClient(env, 'test-token-bearer', tracker);
  const job = buildJobFixture();
  // Pass-through constructor: the production code uses BitbucketAdapter.create() (async factory),
  // but the adapter's per-method contract is independent of credential reading, so we exercise the
  // private constructor shape via `as unknown as` once the class exists.
  const adapter = new (BitbucketAdapter as unknown as new (
    env: ReturnType<typeof createTestEnv>,
    client: BitbucketClient,
    job: ReturnType<typeof buildJobFixture>,
    tracker: { incrementSubrequests: ReturnType<typeof vi.fn> },
  ) => BitbucketAdapter)(env, client, job, tracker);
  return { adapter, client, env, tracker };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('BitbucketAdapter (VcsProvider mapping)', () => {
  it('exposes name="bitbucket" (Bitbucket has no native PR labels)', () => {
    const { adapter } = buildAdapter();
    expect(adapter.name).toBe('bitbucket');
  });

  it('flattens the Bitbucket PR shape into VcsPullRequest (headSha=source.commit.hash, baseSha=destination.commit.hash)', async () => {
    const mock = installBitbucketFetchMock();
    const { adapter } = buildAdapter();
    const pr = await adapter.getPullRequest(WORKSPACE, REPO, PR_NUMBER);
    expect(pr).toEqual({
      number: PR_NUMBER,
      title: 'Add Bitbucket support',
      body: 'Review Bitbucket pull requests.',
      draft: false,
      headSha: 'head123',
      headRef: 'feature/bitbucket',
      baseSha: 'base123',
      baseRef: 'main',
      authorLogin: 'alice',
    });
    expect(mock.calls[0].path).toBe(`/2.0/repositories/${WORKSPACE}/${REPO}/pullrequests/${PR_NUMBER}`);
  });

  it('delegates getPullRequestDiff to BitbucketClient', async () => {
    const mock = installBitbucketFetchMock({
      getPullRequestDiffResponse: {
        body: 'diff --git a/src/foo.ts b/src/foo.ts\n+const added = true;\n',
        headers: { 'content-type': 'text/plain' },
      },
    });
    const { adapter } = buildAdapter();
    const diff = await adapter.getPullRequestDiff(WORKSPACE, REPO, PR_NUMBER);
    expect(diff).toContain('+const added = true;');
    expect(mock.calls[0].path).toBe(`/2.0/repositories/${WORKSPACE}/${REPO}/pullrequests/${PR_NUMBER}/diff?context=3`);
  });

  it('createStatusCheck PUTs a Code Insights report with REPORT_TYPE=BUG, result=PASSED, returns { ref: "codra-review" }', async () => {
    const mock = installBitbucketFetchMock();
    const { adapter } = buildAdapter();

    const { ref } = await adapter.createStatusCheck(WORKSPACE, REPO, {
      headSha: HEAD_SHA,
      title: 'Review queued',
      summary: 'Codra has started reviewing this pull request.',
    });

    expect(ref).toBe('codra-review');
    const put = mock.calls.find((call) => call.method === 'PUT' && call.path.includes('/reports/codra-review'));
    expect(put).toBeDefined();
    expect(put?.body).toMatchObject({
      title: 'Review queued',
      details: 'Codra has started reviewing this pull request.',
      report_type: 'BUG',
      result: 'PASSED',
    });
  });

  it('updateStatusCheck PUTs the report THEN POSTs the build status with key="codra-review" (regardless of ref)', async () => {
    const mock = installBitbucketFetchMock();
    const { adapter } = buildAdapter();

    await adapter.updateStatusCheck(WORKSPACE, REPO, 'something-else', {
      title: 'LGTM',
      summary: 'No issues',
      status: 'completed',
      conclusion: 'success',
    });

    // PUT report happens first.
    const put = mock.calls.find((call) => call.method === 'PUT' && call.path.includes('/reports/codra-review'));
    expect(put).toBeDefined();
    expect(put?.body).toMatchObject({ result: 'PASSED', title: 'LGTM' });

    // POST build status uses HARDCODED key='codra-review' regardless of ref argument (REV-M-10).
    const post = mock.calls.find((call) => call.method === 'POST' && call.path.includes('/statuses/build'));
    expect(post).toBeDefined();
    expect(post?.body).toMatchObject({
      key: 'codra-review',
      state: 'SUCCESSFUL',
      description: 'LGTM',
    });
    // POST comes AFTER PUT.
    const putIndex = mock.calls.indexOf(put!);
    const postIndex = mock.calls.indexOf(post!);
    expect(putIndex).toBeLessThan(postIndex);
  });

  it('updateStatusCheck maps verdict="comment" (conclusion="neutral") to SUCCESSFUL (NOT INPROGRESS — the antigravity merge-blocking bug)', async () => {
    const mock = installBitbucketFetchMock();
    const { adapter } = buildAdapter();

    await adapter.updateStatusCheck(WORKSPACE, REPO, 'codra-review', {
      title: 'Comments posted',
      summary: 'No blocking findings',
      status: 'completed',
      conclusion: 'neutral',
    });

    const post = mock.calls.find((call) => call.method === 'POST' && call.path.includes('/statuses/build'));
    expect(post?.body).toMatchObject({
      key: 'codra-review',
      state: 'SUCCESSFUL',
      description: 'Comments posted',
    });
    expect(post?.body).not.toMatchObject({ state: 'INPROGRESS' });
  });

  it('updateStatusCheck maps conclusion="failure" to FAILED', async () => {
    const mock = installBitbucketFetchMock();
    const { adapter } = buildAdapter();

    await adapter.updateStatusCheck(WORKSPACE, REPO, 'codra-review', {
      title: 'Review failed',
      summary: 'Something blew up',
      status: 'completed',
      conclusion: 'failure',
    });

    const post = mock.calls.find((call) => call.method === 'POST' && call.path.includes('/statuses/build'));
    expect(post?.body).toMatchObject({ state: 'FAILED', description: 'Review failed' });
  });

  it('updateStatusCheck maps status="in_progress" to INPROGRESS', async () => {
    const mock = installBitbucketFetchMock();
    const { adapter } = buildAdapter();

    await adapter.updateStatusCheck(WORKSPACE, REPO, 'codra-review', {
      title: 'Reviewing',
      summary: 'in flight',
      status: 'in_progress',
    });

    const post = mock.calls.find((call) => call.method === 'POST' && call.path.includes('/statuses/build'));
    expect(post?.body).toMatchObject({ state: 'INPROGRESS' });
  });

  it('submitReview posts the combined marker+summary as the FINAL comment (REV-R-A)', async () => {
    const mock = installBitbucketFetchMock({
      postPullRequestCommentResponses: [
        { status: 201, body: { id: 100 } }, // inline comment
        { status: 201, body: { id: 101 } }, // combined marker+summary
      ],
      listPullRequestCommentsResponse: { body: { values: [] } },
    });
    const { adapter, env } = buildAdapter();
    // Seed the diff cache so submitReview can translate position=3 to a valid anchor.
    const seededDiff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      'index 1234567..890abcd 100644',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,1 +1,3 @@',
      ' context',
      '+added1',
      '+added2',
    ].join('\n');
    await env.APP_KV.put(`diff:${(adapter as unknown as { job: { id: string } }).job.id}`, seededDiff);

    const input: VcsSubmitReviewInput = {
      commitSha: COMMIT_SHA,
      verdict: 'comment',
      summaryBody: 'Looks mostly good',
      jobIdHint: 'job-bb-1',
      comments: [
        { path: 'src/foo.ts', position: 3, body: 'first inline comment' },
      ],
    };

    const { ref } = await adapter.submitReview(WORKSPACE, REPO, PR_NUMBER, input);
    expect(ref).toBe('101');

    const commentPosts = mock.calls.filter(
      (call) => call.method === 'POST' && call.path.includes('/pullrequests/') && call.path.endsWith('/comments'),
    );
    expect(commentPosts).toHaveLength(2);

    // The LAST post is the summary with the clean Bitbucket dedup footer (Thread C): no
    // GitHub-flavored HTML marker (`<!-- ... -->`) and no `<sub>` — both render as junk on Bitbucket.
    const combined = commentPosts[commentPosts.length - 1];
    const raw = (combined.body as { content: { raw: string } }).content.raw;
    expect(raw).toContain('codra-review · reviewed commit `head123`');
    expect(raw).not.toContain('<!--');
    expect(raw).not.toContain('<sub>');
    expect(raw).toContain('Looks mostly good');
    // The summary body comes first; the dedup footer is appended last.
    expect(raw.indexOf('Looks mostly good')).toBeLessThan(raw.indexOf('codra-review · reviewed commit'));

    // The first post is the inline comment, with the file/line anchor.
    const inline = commentPosts[0];
    expect(inline.body).toMatchObject({
      content: { raw: 'first inline comment' },
      inline: { path: 'src/foo.ts', to: 3 },
    });
  });

  it('submitReview skips an inline comment when a matching one already exists in the dedup set (REV-R-A dedup)', async () => {
    // Seed listPullRequestComments with an existing comment matching the proposed one.
    const mock = installBitbucketFetchMock({
      listPullRequestCommentsResponse: {
        body: {
          values: [
            {
              id: 999,
              content: { raw: 'first inline comment' },
              inline: { path: 'src/foo.ts', to: 1 },
            },
          ],
        },
      },
      postPullRequestCommentResponses: [
        // Only the combined marker+summary is posted.
        { status: 201, body: { id: 200 } },
      ],
    });
    const { adapter } = buildAdapter();

    const { ref } = await adapter.submitReview(WORKSPACE, REPO, PR_NUMBER, {
      commitSha: COMMIT_SHA,
      verdict: 'comment',
      summaryBody: 'Looks good',
      jobIdHint: 'job-bb-1',
      comments: [
        { path: 'src/foo.ts', position: 1, body: 'first inline comment' },
      ],
    });
    expect(ref).toBe('200');

    // Only one POST: the combined marker+summary. The duplicate inline was skipped.
    const commentPosts = mock.calls.filter(
      (call) => call.method === 'POST' && call.path.includes('/comments'),
    );
    expect(commentPosts).toHaveLength(1);
  });

  it('submitReview calls approvePullRequest ONLY when verdict === "approve"', async () => {
    const mock = installBitbucketFetchMock({
      listPullRequestCommentsResponse: { body: { values: [] } },
      postPullRequestCommentResponses: [
        { status: 201, body: { id: 300 } },
      ],
    });
    const { adapter } = buildAdapter();

    await adapter.submitReview(WORKSPACE, REPO, PR_NUMBER, {
      commitSha: COMMIT_SHA,
      verdict: 'comment',
      summaryBody: 'Just notes',
      jobIdHint: 'job-bb-1',
      comments: [],
    });

    const approve = mock.calls.find((call) => call.method === 'POST' && call.path.endsWith('/approve'));
    expect(approve).toBeUndefined();

    // Now verify the approve path IS taken for verdict === 'approve'.
    const mock2 = installBitbucketFetchMock({
      listPullRequestCommentsResponse: { body: { values: [] } },
      postPullRequestCommentResponses: [{ status: 201, body: { id: 400 } }],
    });
    const adapter2 = buildAdapter().adapter;
    await adapter2.submitReview(WORKSPACE, REPO, PR_NUMBER, {
      commitSha: COMMIT_SHA,
      verdict: 'approve',
      summaryBody: 'LGTM',
      jobIdHint: 'job-bb-1',
      comments: [],
    });
    const approve2 = mock2.calls.find((call) => call.method === 'POST' && call.path.endsWith('/approve'));
    expect(approve2).toBeDefined();
  });

  it('findExistingReviewForCommit lists comments and filters for the codra-review footer with the commit substring', async () => {
    const matchingId = 555;
    const mock = installBitbucketFetchMock({
      listPullRequestCommentsResponse: {
        body: {
          values: [
            { id: 100, content: { raw: 'unrelated comment' }, inline: undefined },
            {
              id: matchingId,
              content: {
                raw: `Looks good\n\n---\n\ncodra-review · reviewed commit \`${COMMIT_SHA}\``,
              },
              inline: undefined,
            },
          ],
        },
      },
    });
    const { adapter } = buildAdapter();

    const result = await adapter.findExistingReviewForCommit(WORKSPACE, REPO, PR_NUMBER, COMMIT_SHA);
    expect(result).toEqual({ ref: String(matchingId) });
    expect(mock.calls[0].path).toContain(`/pullrequests/${PR_NUMBER}/comments?pagelen=100`);
  });

  it('findExistingReviewForCommit returns null when no marker comment is found', async () => {
    installBitbucketFetchMock({
      listPullRequestCommentsResponse: {
        body: { values: [{ id: 1, content: { raw: 'unrelated' }, inline: undefined }] },
      },
    });
    const { adapter } = buildAdapter();

    const result = await adapter.findExistingReviewForCommit(WORKSPACE, REPO, PR_NUMBER, COMMIT_SHA);
    expect(result).toBeNull();
  });

  it('translates VcsReviewComment.position to Bitbucket inline anchor by walking the parsed FileDiff', async () => {
    // The diff has two hunks, with positions accumulating across hunks (parseUnifiedDiff
    // increments position globally per file). After parseUnifiedDiff we get:
    //   - hunk 1 (@@ -1,1 +1,2 @@): context pos=1 (newLine=1); added pos=2 (newLine=2)
    //   - hunk 2 (@@ -5,1 +6,2 @@): deleted pos=3 (oldLine=5); context pos=4 (newLine=6); added pos=5 (newLine=7)
    // The walk searches flattened hunk lines for `line.position === comment.position` (uniform).
    const rawDiff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      'index 1234567..890abcd 100644',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,1 +1,2 @@',
      ' context',
      '+added',
      '@@ -5,1 +6,2 @@',
      '-deleted',
      ' contextA',
      '+addedB',
    ].join('\n');
    const files = parseUnifiedDiff(rawDiff);
    expect(files).toHaveLength(1);
    // Seed the diff cache so submitReview can walk it.
    const { adapter, env } = buildAdapter();
    await env.APP_KV.put(`diff:${(adapter as unknown as { job: { id: string } }).job.id}`, rawDiff);

    const mock = installBitbucketFetchMock({
      listPullRequestCommentsResponse: { body: { values: [] } },
      postPullRequestCommentResponses: [
        { status: 201, body: { id: 501 } },
        { status: 201, body: { id: 502 } },
        { status: 201, body: { id: 503 } },
      ],
    });

    await adapter.submitReview(WORKSPACE, REPO, PR_NUMBER, {
      commitSha: COMMIT_SHA,
      verdict: 'comment',
      summaryBody: 'notes',
      jobIdHint: 'job-bb-1',
      comments: [
        { path: 'src/foo.ts', position: 2, body: 'added line note' },
        { path: 'src/foo.ts', position: 3, body: 'removed line note' },
        { path: 'src/foo.ts', position: 5, body: 'addedB note' },
      ],
    });

    // Find each comment's POST. The inline posts are interleaved with the list-comments call,
    // so filter for inline posts (the ones with `inline` in body).
    const inlinePosts = mock.calls.filter(
      (call) => call.method === 'POST' && call.path.endsWith('/comments') && (call.body as { inline?: unknown })?.inline !== undefined,
    );
    expect(inlinePosts).toHaveLength(3);

    // Position 2 -> newLineNumber=2 (to=2, line_type='added').
    expect(inlinePosts[0].body).toMatchObject({
      content: { raw: 'added line note' },
      inline: { path: 'src/foo.ts', to: 2 },
    });

    // Position 3 -> oldLineNumber=5 (from=5, line_type='removed') via R-03 inverse mapping.
    expect(inlinePosts[1].body).toMatchObject({
      content: { raw: 'removed line note' },
      inline: { path: 'src/foo.ts', from: 5 },
    });

    // Position 5 -> newLineNumber=7 (to=7, line_type='added').
    expect(inlinePosts[2].body).toMatchObject({
      content: { raw: 'addedB note' },
      inline: { path: 'src/foo.ts', to: 7 },
    });
  });
});