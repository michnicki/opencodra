import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { AppBindings } from '@server/env';
import { runReviewJob } from '@server/core/review';
import { type ReviewJobMessage } from '@shared/schema';
import { setJobWorkflowInstance } from '@server/db/jobs';
import { logger } from '@server/core/logger';
import { runBestEffortJobMaintenance } from '@server/core/job-recovery';
import { runWithDb } from '@server/db/client';

export class ReviewWorkflow extends WorkflowEntrypoint<AppBindings, ReviewJobMessage> {
  async run(event: WorkflowEvent<ReviewJobMessage>, step: WorkflowStep) {
    // Share one DB client/connection for this entire invocation instead of opening a
    // new Hyperdrive connection per query (the default behavior of getDb() outside any
    // runWithDb() context). On workflow replay after a step.sleep or a resumed retry,
    // this simply runs again and creates a fresh client for that new invocation.
    return runWithDb(this.env, () => this.execute(event, step));
  }

  private async execute(event: WorkflowEvent<ReviewJobMessage>, step: WorkflowStep) {
    const params = event.payload;
    const env = this.env;

    const jobId = params.jobId ?? params.deliveryId;

    await step.do('bind-workflow-id', async () => {
      try {
        if (jobId) {
          await setJobWorkflowInstance(env, jobId, event.instanceId);
        }
      } catch (err) {
        logger.warn('Failed to bind workflow ID to job', err instanceof Error ? err : new Error(String(err)));
      }
    });

    try {
      await step.do('pre-maintenance', async () => {
        await runBestEffortJobMaintenance(env);
      });
    } catch (e) {
      // Ignore maintenance errors
    }

    let phase = params.phase ?? 'prepare';
    let delaySeconds = 0;
    let attempt = 0;

    while (phase) {
      attempt++;

      if (delaySeconds > 0) {
        await step.sleep(`sleep-${phase}-${attempt}`, `${delaySeconds} seconds`);
      }

      const currentPhase = phase;
      
      let result;
      try {
        result = await step.do(`run-${currentPhase}-${attempt}`, {
          retries: { limit: 5, delay: '60 seconds', backoff: 'exponential' },
          timeout: '15 minutes'
        }, async () => {
          return await runReviewJob(env, { ...params, phase: currentPhase });
        });
      } catch (error) {
        await step.do(`telemetry-failure-${currentPhase}-${attempt}`, async () => {
          const { sendTelemetryEvent } = await import('@server/core/telemetry');
          await sendTelemetryEvent(env, {
            linesReviewed: 0,
            findingsReported: 0,
            inputTokens: 0,
            outputTokens: 0,
            modelsUsed: [],
            fileExtensions: [],
            triggerType: params.eventName === 'pull_request' ? 'auto' : 'mention',
            reviewDurationMs: 0,
            filesReviewed: 0,
            verdict: 'failed',
            severityDistribution: {},
          });
        });
        throw error;
      }

      if (result.action === 'next_phase') {
        phase = result.phase;
        // Force a 1-second sleep minimum to yield execution back to Cloudflare.
        // This resets the 50 subrequest per-invocation limit between chunks/phases!
        delaySeconds = result.delaySeconds ? Math.max(result.delaySeconds, 1) : 1;
      } else if (result.action === 'retry') {
        // Keep the same phase, just delay
        delaySeconds = result.delaySeconds ?? 60;
      } else {
        // 'ack' or completion
        break;
      }
    }

    // Yield before maintenance so it runs in a fresh invocation with its own subrequest
    // budget, rather than immediately after the final phase step (which may have just
    // exhausted the current invocation's budget, guaranteeing this call would also fail).
    await step.sleep('pre-post-maintenance-yield', '1 second');

    try {
      await step.do('post-maintenance', async () => {
        await runBestEffortJobMaintenance(env);
      });
    } catch (e) {
      // Ignore maintenance errors
    }
  }
}
