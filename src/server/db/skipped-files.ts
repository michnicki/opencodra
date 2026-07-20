import type { AppBindings } from '@server/env';
import type { VcsProvider } from '@shared/schema';
import { queryRows } from './client';
import { hexToBytes } from './jobs';

/**
 * D-10 / CMD-02 (Phase 11): typed accessors for the `skipped_files` table (migration 009) --
 * bookkeeping of files a full review omitted for size, so a later `review-rest` job can re-review
 * exactly those paths.
 *
 * One module per domain (mirrors db/pr-review-state.ts). No consumer is wired this plan; the
 * prepare-phase producer and the review-rest consumer land in later Phase 11 plans. This module
 * establishes the typed, parameterized, immutable-id-keyed accessor surface.
 *
 * Every statement is parameterized via queryRows -- NO string interpolation of VALUES (V5 Input
 * Validation / SQLi mitigation, T-11-01-1). The only interpolation is positional-placeholder
 * construction ($N) for the multi-row insert, never a value.
 */

// IN-01: the only producer (`partitionReviewableFiles`) omits files purely at the `max_files` count
// boundary, so every recorded skip is `'max_files'`. There is no size-based omission at this boundary
// and `review-rest` re-reviews all omitted paths regardless, so no `'too_large'` distinction is
// needed — the previously-declared variant was dead. Reintroduce it only if a real size-based
// omission producer is added.
export type SkippedFileReason = 'max_files';

/**
 * The PR-identity lookup key. `listSkippedFilesForHead` queries on this tuple + the CURRENT head_sha
 * ACROSS ANY job (REVIEW: Codex 11-01 HIGH) -- a review-rest run is a NEW job and cannot find the
 * original full-review job's skips by job_id. `vcsProvider` is the shared union, `workspace` is the
 * canonical per-provider value (GitHub owner/login, Bitbucket workspace slug), and `headSha` is the
 * 40-char hex sha the skip was computed against.
 */
export type SkippedFilesHeadKey = {
  vcsProvider: VcsProvider;
  workspace: string;
  repoSlug: string;
  prNumber: number;
  headSha: string;
};

export type SkippedFileRow = {
  id: string;
  job_id: string;
  vcs_provider: VcsProvider;
  workspace: string;
  repo_slug: string;
  pr_number: number;
  // BYTEA on the wire -- postgres.js returns it as a Uint8Array/Buffer. Callers that need the hex
  // form use bytesToHex (jobs.ts). listSkippedFilesForHead never surfaces it (returns file_paths).
  head_sha: Uint8Array | string;
  file_path: string;
  reason: string;
  created_at: string;
};

/**
 * Persist a batch of skipped files for one job in a single parameterized multi-row INSERT.
 * ON CONFLICT (job_id, file_path) DO NOTHING makes an idempotent re-run of the same prepare phase a
 * no-op. An empty batch is a no-op (no statement issued). `headSha` is a 40-char hex string, stored
 * as BYTEA via hexToBytes (mirroring jobs.commit_sha).
 */
export async function insertSkippedFiles(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  input: {
    jobId: string;
    vcsProvider: VcsProvider;
    workspace: string;
    repoSlug: string;
    prNumber: number;
    headSha: string;
    files: Array<{ filePath: string; reason: string }>;
  },
): Promise<void> {
  if (input.files.length === 0) return;

  const headShaBytes = hexToBytes(input.headSha);
  const params: unknown[] = [];
  const tuples: string[] = [];

  for (const file of input.files) {
    const base = params.length;
    // Positional placeholders only -- every value below is bound, never interpolated.
    tuples.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`,
    );
    params.push(
      input.jobId,
      input.vcsProvider,
      input.workspace,
      input.repoSlug,
      input.prNumber,
      headShaBytes,
      file.filePath,
      file.reason,
    );
  }

  await queryRows(
    env,
    `
      INSERT INTO skipped_files
        (job_id, vcs_provider, workspace, repo_slug, pr_number, head_sha, file_path, reason)
      VALUES ${tuples.join(', ')}
      ON CONFLICT (job_id, file_path) DO NOTHING
    `,
    params,
  );
}

/**
 * Return the distinct file paths recorded as skipped for a PR at a specific head, oldest-first,
 * across ANY job (REVIEW: Codex 11-01 HIGH). Empty array when none. Fully parameterized; head_sha is
 * compared as BYTEA via hexToBytes.
 */
export async function listSkippedFilesForHead(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  key: SkippedFilesHeadKey,
): Promise<string[]> {
  const rows = await queryRows<{ file_path: string }>(
    env,
    `
      SELECT file_path
      FROM skipped_files
      WHERE vcs_provider = $1
        AND workspace = $2
        AND repo_slug = $3
        AND pr_number = $4
        AND head_sha = $5
      GROUP BY file_path
      ORDER BY MIN(created_at) ASC, file_path ASC
    `,
    [key.vcsProvider, key.workspace, key.repoSlug, key.prNumber, hexToBytes(key.headSha)],
  );
  return rows.map((row) => row.file_path);
}
