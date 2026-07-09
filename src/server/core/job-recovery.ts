import type { AppBindings } from '@server/env';
import { getTerminalJobsNeedingCheckRunCompletion, markJobCheckRunCompleted, recoverExpiredJobLeases } from '@server/db/jobs';
import { logger } from '@server/core/logger';
import { GitHubService } from '@server/services/github';

const MAX_RECOVERY_COUNT = 3;

export async function recoverJobs(env: AppBindings) {
  try {
    const recovered = await recoverExpiredJobLeases(env, MAX_RECOVERY_COUNT);
    for (const jobId of recovered.requeuedJobIds) {
      await env.REVIEW_QUEUE.send({
        jobId,
        deliveryId: crypto.randomUUID(),
        phase: 'review',
      });
    }

    if (recovered.requeuedJobIds.length > 0 || recovered.failedJobs.length > 0) {
      logger.warn('Expired job leases recovered', {
        requeued: recovered.requeuedJobIds.length,
        failed: recovered.failedJobs.length,
      });
    }
  } catch (err) {
    logger.error('Failed to recover expired job leases', err instanceof Error ? err : new Error(String(err)));
  }
}

export async function completeTerminalCheckRuns(env: AppBindings) {
  // Limit to 1 to avoid Cloudflare's 50 subrequest limit per invocation,
  // especially when called opportunistically via waitUntil during API polling.
  // Each job requires multiple subrequests (KV, GitHub API, Hyperdrive).
  const jobs = await getTerminalJobsNeedingCheckRunCompletion(env, 1);
  for (const job of jobs) {
    if (!job.check_run_id) continue;

    try {
      const github = new GitHubService(env, job.installation_id);
      const checkRunPresentation = {
        superseded: { conclusion: 'neutral' as const, title: 'Review superseded', summary: 'Superseded by a newer commit or job.' },
        cancelled: { conclusion: 'cancelled' as const, title: 'Review stopped', summary: 'Stopped by user.' },
        failed: { conclusion: 'failure' as const, title: 'Review failed', summary: 'Review failed.' },
      };
      const presentation = checkRunPresentation[job.status as keyof typeof checkRunPresentation] ?? checkRunPresentation.failed;
      await github.updateCheckRun(job.owner, job.repo, job.check_run_id, {
        status: 'completed',
        conclusion: presentation.conclusion,
        title: presentation.title,
        summary: job.error_msg ?? presentation.summary,
      });
      await markJobCheckRunCompleted(env, job.id);
    } catch (error) {
      logger.error(`Failed to complete terminal check run for job ${job.id}`, error instanceof Error ? error : new Error(String(error)));
    }
  }
}

export async function runOpportunisticJobMaintenance(env: AppBindings) {
  await recoverJobs(env);
  await completeTerminalCheckRuns(env);
}

export async function runBestEffortJobMaintenance(env: AppBindings) {
  try {
    await runOpportunisticJobMaintenance(env);
  } catch (error) {
    logger.error('Opportunistic job maintenance failed', error instanceof Error ? error : new Error(String(error)));
  }
}

export function scheduleBestEffortJobMaintenance(
  env: AppBindings,
  executionCtx?: Pick<ExecutionContext, 'waitUntil'>,
) {
  const task = runBestEffortJobMaintenance(env);
  if (executionCtx) {
    executionCtx.waitUntil(task);
  }
}
