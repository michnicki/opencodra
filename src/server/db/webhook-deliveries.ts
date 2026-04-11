import type { AppBindings } from '@server/env';
import { queryRows } from './client';

export async function recordWebhookDelivery(
  env: Pick<AppBindings, 'NEON_DATABASE_URL'>,
  input: {
    deliveryId: string;
    eventName: string;
    owner: string | null;
    repo: string | null;
    payload: unknown;
  },
) {
  const rows = await queryRows<{ id: string }>(
    env,
    `
      INSERT INTO webhook_deliveries (delivery_id, event_name, owner, repo, payload)
      VALUES ($1, $2, $3, $4, $5::jsonb)
      ON CONFLICT (delivery_id) DO NOTHING
      RETURNING id
    `,
    [input.deliveryId, input.eventName, input.owner, input.repo, JSON.stringify(input.payload)],
  );

  return rows.length > 0;
}
