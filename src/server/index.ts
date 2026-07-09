import { createApp } from './app';
import { runReviewJob } from './core/review';
import { ReviewWorkflow } from './workflows/review';
import type { AppBindings } from './env';
import { reviewJobMessageSchema } from '@shared/schema';
import { logger } from '@server/core/logger';
import { runWithDb } from '@server/db/client';
import { failJob, hasPendingMaintenanceWork, clearSystemActive } from '@server/db/jobs';
import { runBestEffortJobMaintenance } from '@server/core/job-recovery';

const app = createApp();

export { ReviewWorkflow };

export default {
  fetch(request: Request, env: AppBindings, ctx: ExecutionContext) {
    return runWithDb(env, () => app.fetch(request, env, ctx));
  },

  async scheduled(_controller: ScheduledController, env: AppBindings, _ctx: ExecutionContext) {
    // The cron fires every 2 minutes, but its only job is maintenance (recovering stuck jobs and
    // finishing check runs). Touching Postgres on every tick would keep the serverless DB awake
    // 24/7. So gate the DB work on a KV flag that is set whenever a job is created/claimed and
    // cleared below once there is genuinely nothing left to maintain. When the flag is absent we
    // return without ever opening a DB connection, letting Postgres suspend.
    try {
      const active = await env.APP_KV.get('system:active_jobs');
      if (!active) {
        return;
      }
    } catch (error) {
      logger.warn('Failed to read active jobs flag from KV, proceeding with maintenance', error instanceof Error ? error : new Error(String(error)));
    }

    return runWithDb(env, async () => {
      await runBestEffortJobMaintenance(env);
      // As soon as no jobs are running/recoverable and no check runs are outstanding, drop the
      // flag so the next tick skips Postgres entirely (instead of waiting out the 20-minute TTL).
      // A new job re-sets the flag on insert/claim, so this only trims the idle tail.
      try {
        if (!(await hasPendingMaintenanceWork(env))) {
          await clearSystemActive(env);
        }
      } catch (error) {
        logger.warn('Failed to evaluate pending maintenance work; leaving active-jobs flag to expire via TTL', error instanceof Error ? error : new Error(String(error)));
      }
    });
  },

  async queue(batch: MessageBatch<unknown>, env: AppBindings, _ctx: ExecutionContext) {
    return runWithDb(env, async () => {
      try {
        await runBestEffortJobMaintenance(env);
      } catch (error) {
        logger.error('Pre-batch maintenance task failed', error instanceof Error ? error : new Error(String(error)));
      }

      for (const message of batch.messages) {
        const parseResult = reviewJobMessageSchema.safeParse(message.body);

        if (!parseResult.success) {
          logger.error('Invalid queue message schema; dropping message', {
            body: message.body,
            error: parseResult.error.flatten(),
          });
          message.ack(); // Drop invalid schema messages
          continue;
        }

        try {
          const id = parseResult.data.jobId ?? parseResult.data.deliveryId;
          if (!id) {
            logger.error('Message missing identifiers; dropping', { body: message.body });
            message.ack();
            continue;
          }
          await env.REVIEW_WORKFLOW.create({
             id,
             params: parseResult.data,
          });
          message.ack();
        } catch (error) {
          if (error instanceof Error && error.message.includes('instance.already_exists')) {
            logger.info('Workflow instance already exists; dropping duplicate queue message.', {
              jobId: parseResult.data.jobId,
              deliveryId: parseResult.data.deliveryId,
            });
            message.ack();
            continue;
          }

          logger.error('Failed to create workflow', error instanceof Error ? error : new Error(String(error)));
          if (message.attempts >= 3) {
            const id = parseResult.data.jobId ?? parseResult.data.deliveryId;
            if (id) {
              try {
                await failJob(env, id, 'Failed to start Cloudflare Workflow after multiple attempts. The Cloudflare infrastructure might be experiencing an outage.');
              } catch (failError) {
                logger.error('Critical: Failed to mark job as failed in DB', failError instanceof Error ? failError : new Error(String(failError)));
              }
            }
            message.ack();
          } else {
            message.retry();
          }
        }
      }

      try {
        await runBestEffortJobMaintenance(env);
      } catch (error) {
        logger.error('Post-batch maintenance task failed', error instanceof Error ? error : new Error(String(error)));
      }
    });
  },
} satisfies ExportedHandler<AppBindings>;
