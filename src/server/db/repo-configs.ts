import type { AppBindings } from '@server/env';
import { parseJsonColumn, queryRows } from './client';
import { defaultRepoConfig, normalizeRepoConfig, repoConfigRecordSchema, repoConfigSchema, type RepoConfig } from '@shared/schema';
import { getOrCreateRepository, findRepositoryByBitbucketIdentity } from './repositories';

type RepoConfigRow = {
  // D-04: NULL for Bitbucket rows (Bitbucket has no GitHub-App installation concept). Typed
  // string | null so a Bitbucket record maps through repoConfigRecordSchema (now nullable) without
  // throwing the Zod error that 500s the config read.
  installation_id: string | null;
  owner: string;
  repo: string;
  workspace: string | null;
  vcs_provider: 'github' | 'bitbucket';
  parsed_json: RepoConfig | string | null;
  updated_at: string;
  main_model: string | null;
  fallback_models: string[] | string | null;
  size_overrides: any | string | null;
  enabled: boolean;
  last_job_created_at: string | null;
  last_job_verdict: 'approve' | 'comment' | null;
};

function mapRepo(row: RepoConfigRow) {
  const parsedJson = normalizeRepoConfig(repoConfigSchema.parse(parseJsonColumn(row.parsed_json, defaultRepoConfig)));
  return repoConfigRecordSchema.parse({
    installationId: row.installation_id,
    owner: row.owner,
    repo: row.repo,
    workspace: row.workspace,
    vcsProvider: row.vcs_provider,
    parsedJson,
    updatedAt: row.updated_at,
    lastJobCreatedAt: row.last_job_created_at,
    lastJobVerdict: row.last_job_verdict,
    mainModel: row.main_model,
    fallbackModels: parseJsonColumn(row.fallback_models, null),
    sizeOverrides: parseJsonColumn(row.size_overrides, null),
    enabled: row.enabled,
  });
}

export async function upsertRepoConfig(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  input: {
    // D-04: nullable so the generic PATCH config path can forward a repo record's now-nullable
    // installationId without a cast; getOrCreateRepository binds it into a nullable column.
    installationId: string | null;
    owner: string;
    repo: string;
    parsedJson: RepoConfig;
    enabled?: boolean;
    // D-05: forwarded to getOrCreateRepository so a Bitbucket write uses the Bitbucket branch
    // (NULL installation_id, ON CONFLICT (vcs_provider, workspace, repo)) and never the GitHub
    // branch that would bind a bogus installation_id / cross-bind a same-named GitHub row. When
    // omitted, getOrCreateRepository defaults vcsProvider to 'github' so existing callers (GitHub
    // PATCH) stay byte-identical (NREG-01).
    vcsProvider?: 'github' | 'bitbucket';
    workspace?: string | null;
  },
) {
  const repositoryId = await getOrCreateRepository(env, {
    installationId: input.installationId ?? '',
    owner: input.owner,
    repo: input.repo,
    vcsProvider: input.vcsProvider,
    workspace: input.workspace,
  });

  const parsedJson = normalizeRepoConfig(input.parsedJson);
  const model = parsedJson.model;
  await queryRows(
    env,
    `
      INSERT INTO repo_configs (repository_id, parsed_json, updated_at, main_model, fallback_models, size_overrides, enabled)
      VALUES ($1, $2::jsonb, now(), $3, $4::jsonb, $5::jsonb, COALESCE($6, TRUE))
      ON CONFLICT (repository_id)
      DO UPDATE
      SET parsed_json = EXCLUDED.parsed_json,
          updated_at = EXCLUDED.updated_at,
          main_model = EXCLUDED.main_model,
          fallback_models = EXCLUDED.fallback_models,
          size_overrides = EXCLUDED.size_overrides,
          enabled = COALESCE($6, repo_configs.enabled)
    `,
    [
      repositoryId,
      JSON.stringify(parsedJson),
      model?.main ?? null,
      model?.fallbacks ? JSON.stringify(model.fallbacks) : null,
      model?.size_overrides ? JSON.stringify(model.size_overrides) : null,
      input.enabled ?? null
    ],
  );
}

// Used during sync — only creates the record if it doesn't exist.
// Preserves all existing model overrides if the repo is already configured.
export async function syncRepoConfig(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  input: {
    installationId: string;
    owner: string;
    repo: string;
  },
) {
  const repositoryId = await getOrCreateRepository(env, {
    installationId: input.installationId,
    owner: input.owner,
    repo: input.repo,
  });

  // Insert with null model overrides (global strategy) but DO NOTHING if already exists
  await queryRows(
    env,
    `
      INSERT INTO repo_configs (repository_id, parsed_json, updated_at, main_model, fallback_models, size_overrides, enabled)
      VALUES ($1, $2::jsonb, now(), NULL, NULL, NULL, TRUE)
      ON CONFLICT (repository_id) DO NOTHING
    `,
    [repositoryId, JSON.stringify(defaultRepoConfig)],
  );
}

export async function deleteStaleRepoConfigs(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  installationId: string,
  activeRepoFullNames: string[]
) {
  if (activeRepoFullNames.length === 0) {
    await queryRows(
      env,
      `
        DELETE FROM repo_configs
        WHERE repository_id IN (
          SELECT id FROM repositories WHERE installation_id = $1
        )
      `,
      [installationId]
    );
    return;
  }

  await queryRows(
    env,
    `
      DELETE FROM repo_configs
      WHERE repository_id IN (
        SELECT id FROM repositories 
        WHERE installation_id = $1 
          AND owner || '/' || repo != ALL($2::text[])
      )
    `,
    [installationId, activeRepoFullNames]
  );
}

export async function updateRepoConfigEnabled(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  input: {
    owner: string;
    repo: string;
    enabled: boolean;
    // Provider-address the toggle (review: Codex HIGH): when supplied, an `AND r.vcs_provider = $4`
    // filter is appended so a same-named GitHub+Bitbucket pair does not both toggle. When omitted
    // the UPDATE is byte-identical to today (NREG-01).
    vcsProvider?: 'github' | 'bitbucket';
  },
) {
  const params: (string | boolean)[] = [input.owner, input.repo, input.enabled];
  let providerFilter = '';
  if (input.vcsProvider) {
    providerFilter = ' AND r.vcs_provider = $4';
    params.push(input.vcsProvider);
  }
  await queryRows(
    env,
    `
      UPDATE repo_configs rc
      SET enabled = $3,
          updated_at = now()
      FROM repositories r
      WHERE rc.repository_id = r.id
        AND r.owner = $1
        AND r.repo = $2${providerFilter}
    `,
    params,
  );
}

export async function listRepoConfigs(env: Pick<AppBindings, 'HYPERDRIVE'>) {
  // LIST MATERIALIZATION (review: Codex HIGH #1): the add-bitbucket flow creates a repositories row
  // + credential but NO repo_config, and the dashboard edit modal reads entirely from this list
  // record (never a per-repo GET), so a config-less Bitbucket repo would be invisible AND
  // uneditable. Before the INNER-JOIN read below, materialize a default repo_config for every
  // Bitbucket repositories row lacking one. Provider-safe (gated on vcs_provider='bitbucket') so a
  // GitHub-only deployment's list read is byte-identical (NREG-01); idempotent via ON CONFLICT.
  await queryRows(
    env,
    `
      INSERT INTO repo_configs (repository_id, parsed_json, updated_at, main_model, fallback_models, size_overrides, enabled)
      SELECT r.id, $1::jsonb, now(), NULL, NULL, NULL, TRUE
      FROM repositories r
      WHERE r.vcs_provider = 'bitbucket'
        AND NOT EXISTS (SELECT 1 FROM repo_configs rc WHERE rc.repository_id = r.id)
      ON CONFLICT (repository_id) DO NOTHING
    `,
    [JSON.stringify(defaultRepoConfig)],
  );

  const rows = await queryRows<RepoConfigRow>(
    env,
    `
      SELECT
        r.installation_id,
        r.owner,
        r.repo,
        r.workspace,
        r.vcs_provider,
        rc.parsed_json,
        rc.updated_at,
        rc.main_model,
        rc.fallback_models,
        rc.size_overrides,
        rc.enabled,
        lj.created_at AS last_job_created_at,
        lj.verdict AS last_job_verdict
      FROM repo_configs rc
      JOIN repositories r ON rc.repository_id = r.id
      LEFT JOIN LATERAL (
        SELECT created_at, verdict
        FROM jobs
        WHERE repository_id = r.id
        ORDER BY created_at DESC
        LIMIT 1
      ) lj ON true
      ORDER BY r.owner ASC, r.repo ASC
    `,
  );

  return rows.map(mapRepo);
}

export async function getRepoConfigRecord(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  owner: string,
  repo: string,
  // Provider-address the read (review: Codex HIGH): when supplied, an `AND r.vcs_provider = $3`
  // filter is appended so a same-named GitHub+Bitbucket pair (allowed by migration 003) never
  // collides. When omitted the query is byte-identical to today's owner/repo-only read (NREG-01).
  vcsProvider?: 'github' | 'bitbucket',
) {
  const readRecord = async () => {
    const params: string[] = [owner, repo];
    let providerFilter = '';
    if (vcsProvider) {
      providerFilter = ' AND r.vcs_provider = $3';
      params.push(vcsProvider);
    }
    const [row] = await queryRows<RepoConfigRow>(
      env,
      `
      SELECT
        r.installation_id,
        r.owner,
        r.repo,
        r.workspace,
        r.vcs_provider,
        rc.parsed_json,
        rc.updated_at,
        rc.main_model,
        rc.fallback_models,
        rc.size_overrides,
        rc.enabled,
        lj.created_at AS last_job_created_at,
        lj.verdict AS last_job_verdict
      FROM repo_configs rc
      JOIN repositories r ON rc.repository_id = r.id
      LEFT JOIN LATERAL (
        SELECT created_at, verdict
        FROM jobs
        WHERE repository_id = r.id
        ORDER BY created_at DESC
        LIMIT 1
      ) lj ON true
      WHERE r.owner = $1 AND r.repo = $2${providerFilter}
      LIMIT 1
    `,
      params,
    );
    return row;
  };

  const row = await readRecord();
  if (row) {
    return mapRepo(row);
  }

  // LAZY DEFAULT (review: Codex HIGH #1, secondary safety net for the PATCH's existing-load): a
  // Bitbucket repo may have a repositories row but no repo_config (add-bitbucket never creates one).
  // Resolve the repository_id provider-SAFELY via findRepositoryByBitbucketIdentity (filters
  // vcs_provider='bitbucket', so it can never collide with a same-named GitHub row — Pitfall #3).
  // Bitbucket's add-repo flow sets owner === workspace, so owner is the workspace here. Gate on
  // Bitbucket only: when vcsProvider is 'github' we NEVER lazily insert (a missing GitHub config
  // still returns null); when vcsProvider is omitted the Bitbucket-identity lookup itself gates it.
  if (vcsProvider === 'github') {
    return null;
  }

  const bitbucketRepositoryId = await findRepositoryByBitbucketIdentity(env, {
    workspace: owner,
    repoSlug: repo,
  });
  if (bitbucketRepositoryId === null) {
    return null;
  }

  await queryRows(
    env,
    `
      INSERT INTO repo_configs (repository_id, parsed_json, updated_at, main_model, fallback_models, size_overrides, enabled)
      VALUES ($1, $2::jsonb, now(), NULL, NULL, NULL, TRUE)
      ON CONFLICT (repository_id) DO NOTHING
    `,
    [bitbucketRepositoryId, JSON.stringify(defaultRepoConfig)],
  );

  const materializedRow = await readRecord();
  return materializedRow ? mapRepo(materializedRow) : null;
}

// Provider-SAFE config read keyed on the exact repository row id (Phase 11 / Plan 07). The
// (owner, repo) accessor above cannot be used for Bitbucket: a GitHub repo and a Bitbucket repo can
// share the same owner/repo text, and that accessor does not filter by vcs_provider — it would return
// the wrong provider's config (the collision `findRepositoryByBitbucketIdentity` exists to avoid). The
// Bitbucket webhook route already resolves the authoritative repository_id via
// `findRepositoryByBitbucketIdentity`, so it reads its per-repo config by that id here — no owner/repo
// text collision possible. Returns null when the repo has no per-repo config row.
export async function getRepoConfigByRepositoryId(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  repositoryId: number,
): Promise<{ parsedJson: RepoConfig; enabled: boolean } | null> {
  const [row] = await queryRows<{ parsed_json: RepoConfig | string | null; enabled: boolean }>(
    env,
    `
      SELECT rc.parsed_json, rc.enabled
      FROM repo_configs rc
      WHERE rc.repository_id = $1
      LIMIT 1
    `,
    [repositoryId],
  );

  if (!row) {
    return null;
  }

  // Parse ONLY the config JSON — NOT via mapRepo/repoConfigRecordSchema, which requires a non-null
  // installationId that Bitbucket repository rows do not have (installation_id is NULL for Bitbucket).
  return {
    parsedJson: normalizeRepoConfig(repoConfigSchema.parse(parseJsonColumn(row.parsed_json, defaultRepoConfig))),
    enabled: row.enabled,
  };
}
