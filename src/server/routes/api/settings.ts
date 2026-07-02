import { Hono } from 'hono';
import type { AppEnv } from '@server/env';
import { getReviewSettings, updateReviewSettings } from '@server/db/app-settings';
import { jsonError } from '@server/core/http';
import { reviewSettingsSchema } from '@shared/schema';

export function createSettingsRouter() {
  const app = new Hono<AppEnv>();

  app.get('/', async (c) => {
    const settings = await getReviewSettings(c.env);
    return c.json({ settings });
  });

  app.patch('/', async (c) => {
    const parsed = reviewSettingsSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return jsonError('Invalid review settings.', 400);
    }

    await updateReviewSettings(c.env, parsed.data);
    return c.json({ ok: true });
  });

  return app;
}
