import { createApp } from './app';
import { runReviewJob } from './core/review';
import { ReviewWorkflow } from './workflows/review';
import type { AppBindings } from './env';
import { reviewJobMessageSchema } from '@shared/schema';
import { logger } from '@server/core/logger';
import { runWithDb } from '@server/db/client';
import { failJob } from '@server/db/jobs';
import { runBestEffortJobMaintenance } from '@server/core/job-recovery';

const app = createApp();

export { ReviewWorkflow };

export default {
  fetch(request: Request, env: AppBindings, ctx: ExecutionContext) {
    return runWithDb(env, () => app.fetch(request, env, ctx));
  },

  async scheduled(_controller: ScheduledController, env: AppBindings, _ctx: ExecutionContext) {
    return runWithDb(env, async () => {
      await runBestEffortJobMaintenance(env);
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
