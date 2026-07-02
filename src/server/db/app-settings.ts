import type { AppBindings } from '@server/env';
import { queryRows } from './client';
import { logger } from '@server/core/logger';
import { reviewSettingsSchema, type ReviewSettings } from '@shared/schema';

const CONCURRENCY_KEY = 'review_concurrency_level';
const MAX_COMMENTS_KEY = 'review_max_comments';

const DEFAULT_REVIEW_SETTINGS: ReviewSettings = reviewSettingsSchema.parse({});

export async function getReviewSettings(env: Pick<AppBindings, 'HYPERDRIVE'>): Promise<ReviewSettings> {
  try {
    const rows = await queryRows<{ key: string; value: string }>(
      env,
      'SELECT key, value FROM global_settings WHERE key = ANY($1)',
      [[CONCURRENCY_KEY, MAX_COMMENTS_KEY]],
    );
    const map = new Map(rows.map((row) => [row.key, row.value]));
    const parsed = reviewSettingsSchema.safeParse({
      concurrencyLevel: map.get(CONCURRENCY_KEY),
      maxComments: map.has(MAX_COMMENTS_KEY) ? Number(map.get(MAX_COMMENTS_KEY)) : undefined,
    });
    return parsed.success ? parsed.data : DEFAULT_REVIEW_SETTINGS;
  } catch (error) {
    logger.warn('Failed to load review settings, using defaults', {
      error: error instanceof Error ? error.message : String(error),
    });
    return DEFAULT_REVIEW_SETTINGS;
  }
}

export async function updateReviewSettings(env: Pick<AppBindings, 'HYPERDRIVE'>, settings: ReviewSettings): Promise<void> {
  await queryRows(
    env,
    `INSERT INTO global_settings (key, value) VALUES ($1, $2), ($3, $4)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [CONCURRENCY_KEY, settings.concurrencyLevel, MAX_COMMENTS_KEY, String(settings.maxComments)],
  );
}
