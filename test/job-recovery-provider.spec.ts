import { afterEach, describe, expect, it, vi } from 'vitest';
import { completeTerminalCheckRuns } from '@server/core/job-recovery';
import { createTestEnv } from './helpers';

// vi.hoisted ensures the mock factory can reference these before the test file's top-level
// statements execute (vitest hoists vi.mock calls above all imports).
const { forRepoMock, getTerminalJobsNeedingCheckRunCompletionMock, markJobCheckRunCompletedMock } = vi.hoisted(() => ({
  forRepoMock: vi.fn(),
  getTerminalJobsNeedingCheckRunCompletionMock: vi.fn(),
  markJobCheckRunCompletedMock: vi.fn(),
}));

vi.mock('@server/services/vcs', () => ({
  VcsService: {
    forRepo: (...args: unknown[]) => forRepoMock(...args),
  },
}));

vi.mock('@server/db/jobs', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@server/db/jobs')>();
  return {
    ...mod,
    getTerminalJobsNeedingCheckRunCompletion: getTerminalJobsNeedingCheckRunCompletionMock,
    markJobCheckRunCompleted: markJobCheckRunCompletedMock,
  };
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('completeTerminalCheckRuns (REV-M-8 widening)', () => {
  it('routes a GitHub job through VcsService.forRepo (no direct GitHubService construction)', async () => {
    const env = createTestEnv();
    const updateStatusCheckMock = vi.fn().mockResolvedValue(undefined);
    const githubAdapter = { name: 'github', updateStatusCheck: updateStatusCheckMock };
    forRepoMock.mockResolvedValue(githubAdapter);
    getTerminalJobsNeedingCheckRunCompletionMock.mockResolvedValue([
      {
        id: 'job-gh-1',
        status: 'done',
        verdict: 'approve',
        error_msg: null,
        comment_count: 0,
        file_count: 2,
        owner: 'acme',
        repo: 'backend',
        check_run_id: 9001,
        status_check_ref: null,
        installation_id: 'inst-1',
        repositoryVcsProvider: 'github',
        repositoryWorkspace: null,
      },
    ]);

    await completeTerminalCheckRuns(env);

    expect(forRepoMock).toHaveBeenCalledTimes(1);
    expect(forRepoMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'job-gh-1' }), undefined);
    // The numeric check_run_id is forwarded as a string ref.
    expect(updateStatusCheckMock).toHaveBeenCalledWith(
      'acme',
      'backend',
      '9001',
      expect.objectContaining({ status: 'completed', conclusion: 'success', title: 'LGTM' }),
    );
    expect(markJobCheckRunCompletedMock).toHaveBeenCalledWith(expect.anything(), 'job-gh-1');
  });

  it('routes a Bitbucket job through VcsService.forRepo (provider-aware reconciliation)', async () => {
    const env = createTestEnv();
    const updateStatusCheckMock = vi.fn().mockResolvedValue(undefined);
    const bitbucketAdapter = { name: 'bitbucket', updateStatusCheck: updateStatusCheckMock };
    forRepoMock.mockResolvedValue(bitbucketAdapter);
    getTerminalJobsNeedingCheckRunCompletionMock.mockResolvedValue([
      {
        id: 'job-bb-1',
        status: 'done',
        verdict: 'comment',
        error_msg: null,
        comment_count: 3,
        file_count: 2,
        owner: 'acme',
        repo: 'backend',
        check_run_id: null,
        status_check_ref: 'codra-review',
        installation_id: null,
        repositoryVcsProvider: 'bitbucket',
        repositoryWorkspace: 'acme',
      },
    ]);

    await completeTerminalCheckRuns(env);

    expect(forRepoMock).toHaveBeenCalledTimes(1);
    expect(forRepoMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'job-bb-1' }), undefined);
    // The TEXT status_check_ref is forwarded as the provider-opaque ref (REV-M-10).
    expect(updateStatusCheckMock).toHaveBeenCalledWith(
      'acme',
      'backend',
      'codra-review',
      expect.objectContaining({ status: 'completed', conclusion: 'neutral', title: 'Comments posted' }),
    );
    expect(markJobCheckRunCompletedMock).toHaveBeenCalledWith(expect.anything(), 'job-bb-1');
  });

  it('passes the hex-decoded commit_sha to forRepo as headSha (empty-commit 404 fix)', async () => {
    // The raw job row from getTerminalJobsNeedingCheckRunCompletion (SELECT j.*) exposes the head
    // commit ONLY as the bytea `commit_sha` column — not the headSha/commitSha field the Bitbucket
    // adapter's updateStatusCheck reads. Without hex-decoding it here, the adapter posts to an empty
    // `/commit//` segment (the recurring BitbucketError 404). This pins the mapping.
    const env = createTestEnv();
    const updateStatusCheckMock = vi.fn().mockResolvedValue(undefined);
    forRepoMock.mockResolvedValue({ name: 'bitbucket', updateStatusCheck: updateStatusCheckMock });
    getTerminalJobsNeedingCheckRunCompletionMock.mockResolvedValue([
      {
        id: 'job-bb-2',
        status: 'done',
        verdict: 'comment',
        error_msg: null,
        comment_count: 1,
        file_count: 1,
        owner: 'acme',
        repo: 'backend',
        check_run_id: null,
        status_check_ref: 'codra-review',
        installation_id: null,
        repositoryVcsProvider: 'bitbucket',
        repositoryWorkspace: 'acme',
        // postgres.js returns bytea as a `\x`-prefixed hex string; bytesToHex normalizes it.
        commit_sha: '\\xdeadbeef',
      },
    ]);

    await completeTerminalCheckRuns(env);

    expect(forRepoMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'job-bb-2', headSha: 'deadbeef' }),
      undefined,
    );
    expect(markJobCheckRunCompletedMock).toHaveBeenCalledWith(expect.anything(), 'job-bb-2');
  });

  it('skips rows where both check_run_id AND status_check_ref are null (defensive)', async () => {
    const env = createTestEnv();
    getTerminalJobsNeedingCheckRunCompletionMock.mockResolvedValue([
      {
        id: 'job-empty',
        status: 'done',
        verdict: null,
        error_msg: null,
        comment_count: 0,
        file_count: 0,
        owner: 'acme',
        repo: 'backend',
        check_run_id: null,
        status_check_ref: null,
        installation_id: null,
        repositoryVcsProvider: 'github',
        repositoryWorkspace: null,
      },
    ]);

    await completeTerminalCheckRuns(env);

    expect(forRepoMock).not.toHaveBeenCalled();
    expect(markJobCheckRunCompletedMock).not.toHaveBeenCalled();
  });

  it('a VcsService.forRepo rejection is caught and logged, never crashes the maintenance loop', async () => {
    const env = createTestEnv();
    forRepoMock.mockRejectedValue(new Error('Bitbucket credential not configured'));
    getTerminalJobsNeedingCheckRunCompletionMock.mockResolvedValue([
      {
        id: 'job-fail',
        status: 'done',
        verdict: 'comment',
        error_msg: null,
        comment_count: 0,
        file_count: 0,
        owner: 'acme',
        repo: 'backend',
        check_run_id: null,
        status_check_ref: 'codra-review',
        installation_id: null,
        repositoryVcsProvider: 'bitbucket',
        repositoryWorkspace: 'acme',
      },
    ]);

    // The loop must absorb the rejection and complete without throwing.
    await expect(completeTerminalCheckRuns(env)).resolves.toBeUndefined();
    expect(markJobCheckRunCompletedMock).not.toHaveBeenCalled();
  });
});

describe('getTerminalJobsNeedingCheckRunCompletion (REV-M-8 WHERE widening)', () => {
  // Asserts that the SELECT in src/server/db/jobs.ts was widened to OR status_check_ref IS NOT NULL
  // by reading the source file directly (the function is wrapped at runtime by vitest's instrumentation,
  // so .toString() returns the wrapper rather than the original source). This pins the WHERE clause
  // widening so a future migration that narrows it surfaces as a test failure.
  //
  // The regex tolerates the multi-line `-- REV-M-8: ...` comment block that lives BETWEEN the
  // status predicate and the AND clause by allowing arbitrary whitespace/comments in between.
  it('contains the OR widening in the SELECT (REV-M-8)', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const jobsSource = await readFile(
      join(process.cwd(), 'src/server/db/jobs.ts'),
      'utf8',
    );
    // Anchor on the unique terminal-state predicate of getTerminalJobsNeedingCheckRunCompletion.
    const anchor = "WHERE j.status IN ('done', 'failed', 'superseded', 'cancelled')";
    const anchorIdx = jobsSource.indexOf(anchor);
    expect(anchorIdx, 'terminal-state WHERE not found in src/server/db/jobs.ts').toBeGreaterThan(-1);
    // Read a generous window after the anchor that should contain the widened AND clause. The
    // regex tolerates the comment block by matching each token (allowing any whitespace/comments
    // between them) rather than requiring an unbroken literal string. The actual SQL qualifier
    // `j.check_run_id` is preserved because the SELECT is `FROM jobs j` — match either form.
    const window = jobsSource.substring(anchorIdx, anchorIdx + 2000);
    expect(window).toMatch(/(?:j\.)?check_run_id\s+IS\s+NOT\s+NULL\s+OR\s+(?:j\.)?status_check_ref\s+IS\s+NOT\s+NULL/);
  });
});