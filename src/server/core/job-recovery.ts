import type { AppBindings } from '@server/env';
import { bytesToHex, getTerminalJobsNeedingCheckRunCompletion, markJobCheckRunCompleted, recoverExpiredJobLeases } from '@server/db/jobs';
import { logger } from '@server/core/logger';
import { VcsService } from '@server/services/vcs';

const MAX_RECOVERY_COUNT = 3;

export async function recoverJobs(env: AppBindings) {
  try {
    const recovered = await recoverExpiredJobLeases(env, MAX_RECOVERY_COUNT);
    for (const jobId of recovered.requeuedJobIds) {
      await env.REVIEW_QUEUE.send({
        jobId,
        deliveryId: crypto.randomUUID(),
        phase: 'review',
        // The job's previous Workflow instance (keyed on jobId) is dead but still exists, so a
        // same-id create() would be dropped as a duplicate. Force a fresh instance keyed on the new
        // deliveryId so the recovered job actually resumes instead of climbing recovery_count.
        forceFreshInstance: true,
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
    // REV-M-8: the WHERE clause on getTerminalJobsNeedingCheckRunCompletion was widened to
    // (check_run_id IS NOT NULL OR status_check_ref IS NOT NULL) so Bitbucket jobs are
    // eligible. Skip the row entirely only when BOTH columns are null (defensive: a future
    // migration that drops one would otherwise reach this code with no ref to update).
    if (!job.check_run_id && !job.status_check_ref) continue;

    try {
      // REV-M-8: route the reconciliation through VcsService.forRepo (provider-aware) instead
      // of the direct `new GitHubService(env, job.installation_id)` construction. The
      // returned adapter's updateStatusCheck maps the conclusion + status to the provider's
      // native call: GitHub -> updateCheckRun(numeric id, ...); Bitbucket -> PUT Code Insights
      // report + POST commit build status (REV-M-9 verdict mapping baked in). This replaces
      // the previous GitHub-only path so the maintenance sweep is no longer GitHub-blind.
      // getTerminalJobsNeedingCheckRunCompletion returns the raw job row (SELECT j.*), whose head
      // commit lives in the bytea `commit_sha` column — NOT the `headSha`/`commitSha` field the
      // Bitbucket adapter's updateStatusCheck needs. Hex-decode and pass it explicitly so the Code
      // Insights PUT + build-status POST target the real commit instead of an empty `/commit//`
      // segment (the recurring BitbucketError 404 in the ~2-min sweep). GitHub jobs ignore headSha.
      const vcs = await VcsService.forRepo(
        env,
        { ...job, headSha: bytesToHex(job.commit_sha) },
        undefined,
      );

      let conclusion: 'success' | 'neutral' | 'failure' | 'cancelled';
      let title: string;
      let summary: string;
      if (job.status === 'done') {
        // A completed review whose inline check-run update didn't land (e.g. finalize ran out of
        // subrequest budget). Reconstruct the same conclusion finalize would have posted.
        const partial = (job.error_msg ?? '').startsWith('Partial review');
        conclusion = partial ? 'failure' : (job.verdict === 'approve' ? 'success' : 'neutral');
        title = partial ? 'Review partially failed' : (job.verdict === 'approve' ? 'LGTM' : 'Comments posted');
        summary = job.error_msg ?? `${job.comment_count ?? 0} inline comments across ${job.file_count ?? 0} files.`;
      } else {
        const checkRunPresentation = {
          superseded: { conclusion: 'neutral' as const, title: 'Review superseded', summary: 'Superseded by a newer commit or job.' },
          cancelled: { conclusion: 'cancelled' as const, title: 'Review stopped', summary: 'Stopped by user.' },
          failed: { conclusion: 'failure' as const, title: 'Review failed', summary: 'Review failed.' },
        };
        const presentation = checkRunPresentation[job.status as keyof typeof checkRunPresentation] ?? checkRunPresentation.failed;
        conclusion = presentation.conclusion;
        title = presentation.title;
        summary = job.error_msg ?? presentation.summary;
      }

      // Provider-aware ref source: Bitbucket uses the TEXT status_check_ref; GitHub uses
      // the numeric check_run_id. The VcsService.forRepo return value already encodes the
      // provider via `vcs.name`, and `updateStatusCheck` interprets `ref` provider-opaquely
      // (REV-M-10). The `String(...)` cast is necessary for the numeric GitHub case; the
      // Bitbucket string ref is passed through unchanged.
      // Use truthiness (not `??`) so an empty-string status_check_ref does not shadow a valid
      // numeric check_run_id: the skip guard above (`!job.status_check_ref`) is also
      // truthiness-based, so `''` must fall through to the check_run_id branch, matching it.
      const statusRef = job.status_check_ref || (job.check_run_id !== null ? String(job.check_run_id) : '');
      await vcs.updateStatusCheck(job.owner, job.repo, statusRef, {
        status: 'completed',
        conclusion,
        title,
        summary,
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
