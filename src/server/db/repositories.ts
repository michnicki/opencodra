import type { AppBindings } from '@server/env';
import { queryRows } from './client';

export type RepositoryRow = {
  id: number;
  installation_id: string | null; // BIGINT is returned as string by node-postgres; NULL for Bitbucket rows
  owner: string;
  repo: string;
  vcs_provider: string;
  workspace: string | null;
};

export async function getOrCreateRepository(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  input: {
    // D-04: nullable so a Bitbucket-origin caller (NULL installation_id) type-checks. The bitbucket
    // branch already ignores it; the github branch binds it parametrically into a nullable column.
    installationId: string | null;
    owner: string;
    repo: string;
    vcsProvider?: 'github' | 'bitbucket' | string;
    workspace?: string | null;
  },
): Promise<number> {
  // Defaults to 'github' when omitted so all existing call sites (jobs.ts, repo-configs.ts) keep
  // compiling unchanged and continue to resolve to the pre-existing provider (D-05).
  const vcsProvider = input.vcsProvider ?? 'github';

  if (vcsProvider === 'bitbucket') {
    // REV-C-1 / REV-R-B: Bitbucket repos have no installation_id. The bitbucket branch binds NULL
    // for installation_id and uses ON CONFLICT (vcs_provider, workspace, repo) so a Phase-6-created
    // row's installation_id stays NULL even when callers upstream pass an empty-string input. The
    // `installationId` parameter is intentionally ignored in this branch (REV-R-B defense-in-depth
    // -- the column is nullable after migration 005, and the bitbucket path never touches it).
    //
    // Owner/workspace convention (REV-R-C): the caller-supplied owner wins; if the caller omitted
    // owner and only supplied workspace, the caller-supplied input.owner is still the source of
    // truth (the routes pass both consistently). All four placeholders are bound parameterically;
    // no string interpolation.
    const [row] = await queryRows<RepositoryRow>(
      env,
      `
        INSERT INTO repositories (vcs_provider, owner, repo, workspace)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (vcs_provider, workspace, repo) DO UPDATE
          SET owner = EXCLUDED.owner
        RETURNING id
      `,
      [vcsProvider, input.owner, input.repo, input.workspace ?? null],
    );

    return row.id;
  }

  // GitHub (default) path: byte-identical to today's query. The `workspace` parameter is bound as
  // NULL implicitly because the GitHub INSERT column list does not include workspace -- the column
  // is nullable and the GitHub path never reads it.
  const [row] = await queryRows<RepositoryRow>(
    env,
    `
      INSERT INTO repositories (installation_id, owner, repo, vcs_provider)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (vcs_provider, owner, repo) DO UPDATE SET installation_id = EXCLUDED.installation_id
      RETURNING id
    `,
    [input.installationId, input.owner, input.repo, vcsProvider],
  );

  return row.id;
}

/**
 * D-03 lookup for the Bitbucket webhook route. Resolves the repository id from the
 * (vcs_provider, workspace, repo) Bitbucket identity tuple -- the canonical UNIQUE key created by
 * migration 005. Returns the numeric row id, or null when no matching row exists. Parameterized;
 * never string-interpolates workspace/repoSlug. Lowercase inputs are the caller's responsibility
 * (the route normalizes before this call, matching the vcs_credentials storage convention).
 */
export async function findRepositoryByBitbucketIdentity(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  input: { workspace: string; repoSlug: string },
): Promise<number | null> {
  const [row] = await queryRows<{ id: number }>(
    env,
    `SELECT id FROM repositories WHERE vcs_provider = 'bitbucket' AND workspace = $1 AND repo = $2`,
    [input.workspace, input.repoSlug],
  );
  return row ? row.id : null;
}