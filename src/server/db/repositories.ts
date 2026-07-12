import type { AppBindings } from '@server/env';
import { queryRows } from './client';

export type RepositoryRow = {
  id: number;
  installation_id: string; // BIGINT is returned as string by node-postgres
  owner: string;
  repo: string;
  vcs_provider: string;
};

export async function getOrCreateRepository(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  input: { installationId: string; owner: string; repo: string; vcsProvider?: string }
): Promise<number> {
  // Defaults to 'github' when omitted so all existing call sites (jobs.ts, repo-configs.ts) keep
  // compiling unchanged and continue to resolve to the pre-existing provider (D-05).
  const vcsProvider = input.vcsProvider ?? 'github';

  const [row] = await queryRows<RepositoryRow>(
    env,
    `
      INSERT INTO repositories (installation_id, owner, repo, vcs_provider)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (vcs_provider, owner, repo) DO UPDATE SET installation_id = EXCLUDED.installation_id
      RETURNING id
    `,
    [input.installationId, input.owner, input.repo, vcsProvider]
  );

  return row.id;
}
