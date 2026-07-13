import type { AppBindings } from '@server/env';
import { parseJsonColumn, queryRows } from './client';

export async function recordWebhookDelivery(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  input: {
    deliveryId: string;
    eventName: string;
    owner: string | null;
    repo: string | null;
    // REV-R-D: when the caller has already resolved the repository id (e.g. the Bitbucket
    // webhook route, which calls `findRepositoryByBitbucketIdentity` BEFORE HMAC verify per D-05),
    // pass it here to attribute the delivery to the correct row. When omitted, the function keeps
    // its existing owner/repo lookup path -- which is the byte-identical shape the legacy GitHub
    // route uses (NREG-02 / D-02 byte-identity guarantee).
    repositoryId?: number | null;
    payload: unknown;
  },
) {
  let repositoryId: number | null = input.repositoryId ?? null;

  if (repositoryId === null && input.owner && input.repo) {
    const [repoRow] = await queryRows<{ id: number }>(
      env,
      'SELECT id FROM repositories WHERE owner = $1 AND repo = $2',
      [input.owner, input.repo]
    );
    if (repoRow) {
      repositoryId = repoRow.id;
    }
  }

  const rows = await queryRows<{ id: string }>(
    env,
    `
      INSERT INTO webhook_deliveries (delivery_id, event_name, repository_id, payload)
      VALUES ($1, $2, $3, $4::jsonb)
      ON CONFLICT (delivery_id) DO NOTHING
      RETURNING id
    `,
    [input.deliveryId, input.eventName, repositoryId, JSON.stringify(input.payload)],
  );

  return rows.length > 0;
}

export async function getWebhookDelivery(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  deliveryId: string,
) {
  const [row] = await queryRows<{
    delivery_id: string;
    event_name: string;
    payload: unknown;
  }>(
    env,
    `
      SELECT delivery_id, event_name, payload
      FROM webhook_deliveries
      WHERE delivery_id = $1
      LIMIT 1
    `,
    [deliveryId],
  );

  return row ? { ...row, payload: parseJsonColumn(row.payload, null) } : null;
}