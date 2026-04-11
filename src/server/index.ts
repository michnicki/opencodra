import { createApp } from './app';
import { runReviewJob } from './core/review';
import type { AppBindings } from './env';
import { reviewJobMessageSchema } from '@shared/schema';

const app = createApp();

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<unknown>, env: AppBindings, _ctx: ExecutionContext) {
    for (const message of batch.messages) {
      try {
        const payload = reviewJobMessageSchema.parse(message.body);
        await runReviewJob(env, payload);
        message.ack();
      } catch (error) {
        console.error('Queue message failed', error);
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<AppBindings>;
