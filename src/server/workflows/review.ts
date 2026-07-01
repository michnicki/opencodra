import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { AppBindings } from '@server/env';
import { runReviewJob } from '@server/core/review';
import { type ReviewJobMessage } from '@shared/schema';
import { setJobWorkflowInstance } from '@server/db/jobs';
import { logger } from '@server/core/logger';
import { runBestEffortJobMaintenance } from '@server/core/job-recovery';

export class ReviewWorkflow extends WorkflowEntrypoint<AppBindings, ReviewJobMessage> {
  async run(event: WorkflowEvent<ReviewJobMessage>, step: WorkflowStep) {
    const params = event.payload;
    const env = this.env;

    const jobId = params.jobId ?? params.deliveryId;

    await step.do('bind-workflow-id', async () => {
      try {
        if (params.jobId) {
          await setJobWorkflowInstance(env, params.jobId, event.instanceId);
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
      
      const result = await step.do(`run-${currentPhase}-${attempt}`, {
        retries: { limit: 5, delay: '60 seconds', backoff: 'exponential' },
        timeout: '15 minutes'
      }, async () => {
        return await runReviewJob(env, { ...params, phase: currentPhase });
      });

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

    try {
      await step.do('post-maintenance', async () => {
        await runBestEffortJobMaintenance(env);
      });
    } catch (e) {
      // Ignore maintenance errors
    }
  }
}
