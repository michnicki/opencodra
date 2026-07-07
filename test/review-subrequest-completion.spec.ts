import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestEnv } from './helpers';

// Regression coverage for the subrequest-exhaustion incident (PR #26 / job 9dda151e...): a
// review phase that hit Cloudflare's per-invocation subrequest cap (Workers Free plan: 50)
// terminally FAILED the whole job instead of resuming on a fresh budget, so large PRs could
// never finish. These tests pin down that a per-invocation subrequest-limit error reschedules
// the same phase (which the workflow re-runs in a fresh invocation with a fresh budget),
// while an unrelated error still fails the job as before.

const {
  getJobForProcessingMock,
  mapJobMock,
  getOtherRunningJobsCountMock,
  claimJobLeaseMock,
  releaseJobLeaseMock,
  markJobContinuationQueuedMock,
  updateJobStepMock,
  failJobMock,
  markJobCheckRunCompletedMock,
  getPullRequestMock,
} = vi.hoisted(() => ({
  getJobForProcessingMock: vi.fn(),
  mapJobMock: vi.fn(),
  getOtherRunningJobsCountMock: vi.fn(),
  claimJobLeaseMock: vi.fn(),
  releaseJobLeaseMock: vi.fn(),
  markJobContinuationQueuedMock: vi.fn(),
  updateJobStepMock: vi.fn(),
  failJobMock: vi.fn(),
  markJobCheckRunCompletedMock: vi.fn(),
  getPullRequestMock: vi.fn(),
}));

vi.mock('@server/db/jobs', async (importOriginal) => {
  const mod = await importOriginal<any>();
  return {
    ...mod,
    getJobForProcessing: getJobForProcessingMock,
    mapJob: mapJobMock,
    getOtherRunningJobsCount: getOtherRunningJobsCountMock,
    claimJobLease: claimJobLeaseMock,
    releaseJobLease: releaseJobLeaseMock,
    markJobContinuationQueued: markJobContinuationQueuedMock,
    updateJobStep: updateJobStepMock,
    failJob: failJobMock,
    markJobCheckRunCompleted: markJobCheckRunCompletedMock,
  };
});

vi.mock('@server/db/app-settings', async (importOriginal) => {
  const mod = await importOriginal<any>();
  return {
    ...mod,
    getReviewSettings: vi.fn().mockResolvedValue({ concurrencyLevel: 'low', maxComments: 20 }),
  };
});

vi.mock('@server/services/github', () => ({
  GitHubService: class {
    getPullRequest = getPullRequestMock;
    updateCheckRun = vi.fn().mockResolvedValue(undefined);
  },
}));

// Imported after the mocks are registered.
import { runReviewJob } from '@server/core/review';

const JOB_ID = '9dda151e-0c61-4205-9cba-497027706698';

const reviewJob = {
  id: JOB_ID,
  installationId: '123',
  owner: 'test-owner',
  repo: 'test-repo',
  prNumber: 26,
  checkRunId: null as number | null,
  retryOfJobId: null as string | null,
  trigger: 'auto' as const,
  createdAt: new Date().toISOString(),
  // Preparation already done so runReviewPhase proceeds to the review work (and thus to the
  // getPullRequest call we make throw) instead of falling back into runPreparePhase.
  steps: [{ name: 'Preparation', status: 'done' }],
  configSnapshot: undefined,
};

describe('runReviewJob subrequest-budget handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // A claimable, non-terminal job every time.
    getJobForProcessingMock.mockResolvedValue({ check_run_id: null });
    mapJobMock.mockReturnValue(reviewJob);
    getOtherRunningJobsCountMock.mockResolvedValue(0);
    claimJobLeaseMock.mockResolvedValue({ status: 'claimed', row: {} });
    releaseJobLeaseMock.mockResolvedValue(undefined);
    markJobContinuationQueuedMock.mockResolvedValue(undefined);
    updateJobStepMock.mockResolvedValue(undefined);
    failJobMock.mockResolvedValue(undefined);
  });

  it('reschedules the same phase (fresh budget) instead of failing the job when it hits the per-invocation subrequest limit', async () => {
    const env = createTestEnv();
    getPullRequestMock.mockRejectedValue(new Error('Too many subrequests by single Worker invocation.'));

    const result = await runReviewJob(env, { jobId: JOB_ID, phase: 'review' } as any);

    expect(result).toEqual({ action: 'next_phase', phase: 'review', delaySeconds: expect.any(Number) });
    // Queued for continuation and the lease released so the fresh invocation can re-claim it...
    expect(markJobContinuationQueuedMock).toHaveBeenCalledTimes(1);
    expect(releaseJobLeaseMock).toHaveBeenCalledTimes(1);
    // ...and crucially the job was NOT marked failed.
    expect(failJobMock).not.toHaveBeenCalled();
  });

  it('still fails the job terminally for an unrelated (non-subrequest, non-retryable) error', async () => {
    const env = createTestEnv();
    getPullRequestMock.mockRejectedValue(new Error('totally unexpected boom'));

    const result = await runReviewJob(env, { jobId: JOB_ID, phase: 'review' } as any);

    expect(result).toEqual({ action: 'ack' });
    expect(failJobMock).toHaveBeenCalledWith(expect.anything(), JOB_ID, 'totally unexpected boom');
    expect(markJobContinuationQueuedMock).not.toHaveBeenCalled();
  });

  it('keeps rescheduling while the continuation count is still under the ceiling', async () => {
    const env = createTestEnv();
    // markJobContinuationQueued returns the post-increment count; a value at/under the ceiling
    // (MAX_JOB_CONTINUATIONS = 20) must still reschedule rather than give up.
    markJobContinuationQueuedMock.mockResolvedValue(20);
    getPullRequestMock.mockRejectedValue(new Error('Too many subrequests by single Worker invocation.'));

    const result = await runReviewJob(env, { jobId: JOB_ID, phase: 'review' } as any);

    expect(result).toEqual({ action: 'next_phase', phase: 'review', delaySeconds: expect.any(Number) });
    expect(failJobMock).not.toHaveBeenCalled();
  });

  it('fails the job terminally once it exceeds the continuation ceiling without making progress', async () => {
    const env = createTestEnv();
    // Post-increment count above MAX_JOB_CONTINUATIONS (20): the job is wedged, so it must stop
    // churning and fail terminally instead of rescheduling yet again.
    markJobContinuationQueuedMock.mockResolvedValue(21);
    getPullRequestMock.mockRejectedValue(new Error('Too many subrequests by single Worker invocation.'));

    const result = await runReviewJob(env, { jobId: JOB_ID, phase: 'review' } as any);

    expect(result).toEqual({ action: 'ack' });
    expect(failJobMock).toHaveBeenCalledTimes(1);
    expect(failJobMock.mock.calls[0][2]).toMatch(/could not make progress after 21 continuation attempts/);
    expect(releaseJobLeaseMock).toHaveBeenCalled();
  });
});
