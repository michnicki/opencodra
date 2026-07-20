import type { AppBindings } from '@server/env';
import type { VcsProvider } from '@shared/schema';
import { queryRows } from './client';

/**
 * D-01/D-02 (Phase 11 enabler): typed accessors for the `pr_review_state` table (migration 007) --
 * DB-backed, provider-agnostic pause storage for the "pause/resume this PR's review" directive.
 *
 * One module per domain (D-03). No consumer is wired this phase; Phase 11's command dispatch reads
 * and writes pause state through these accessors. This module exists to establish the typed,
 * parameterized, immutable-id-keyed accessor surface on a stable substrate.
 *
 * Every statement is parameterized via queryRows -- NO string interpolation of values (V5 Input
 * Validation / SQLi mitigation, T-07-07), mirroring updateJobStatusCheckRef.
 */

/**
 * The one-row-per-PR identity tuple. `workspace` is a REQUIRED non-null string (Codex HIGH #2): it
 * is the canonical per-provider value the migration-007 `workspace TEXT NOT NULL` column expects --
 * GitHub callers pass the repo owner/login, Bitbucket callers pass the workspace slug. This
 * DELIBERATELY differs from the `repositories` table's GitHub-workspace-NULL convention: because
 * Postgres treats NULLs as distinct under a default UNIQUE, a nullable workspace would let a GitHub
 * PR accumulate duplicate pause rows and break D-01. A non-null workspace makes
 * UNIQUE(vcs_provider, workspace, repo_slug, pr_number) enforce one pause row per PR for GitHub too,
 * and keeps `workspace = $N` equality lookups from ever binding NULL.
 */
export type PrReviewStateKey = {
  // IN-01: narrowed from `string` to the shared `VcsProvider` union ('github' | 'bitbucket') so a
  // typo'd provider ('GitHub', 'bitucket') is a compile-time error rather than silently creating a
  // distinct, orphaned pause row that no correctly-spelled lookup will ever match. The
  // `pr_review_state` table itself still has no DB-level CHECK on `vcs_provider`; adding
  // `CHECK (vcs_provider IN ('github','bitbucket'))` is a DEFERRED follow-up migration decision --
  // migration 007 is already applied to the test/dev databases, so this fix is TS-tightening only.
  vcsProvider: VcsProvider;
  workspace: string;
  repoSlug: string;
  prNumber: number;
};

export type PrReviewStateRow = {
  id: string;
  // IN-01: tightened to the shared union to match the key type. The accessors only ever write a
  // VcsProvider value (via PrReviewStateKey), so rows produced through this module carry a valid
  // provider. (A DB-level CHECK is the deferred follow-up noted above; this type is not a guarantee
  // about arbitrary externally-inserted rows.)
  vcs_provider: VcsProvider;
  workspace: string;
  repo_slug: string;
  pr_number: number;
  paused: boolean;
  // NREG-02 (T-07-08): stores the actor's IMMUTABLE account_id, never a mutable username/handle.
  paused_by: string | null;
  paused_at: string | null;
  created_at: string;
};

/**
 * Return the pause row for a PR, or null when the PR has never been paused (lazy creation means no
 * row exists until the first pause). Parameterized equality lookup on the full non-null identity
 * tuple, so it never binds a NULL workspace.
 */
export async function getPrReviewState(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  key: PrReviewStateKey,
): Promise<PrReviewStateRow | null> {
  const rows = await queryRows<PrReviewStateRow>(
    env,
    `
      SELECT *
      FROM pr_review_state
      WHERE vcs_provider = $1
        AND workspace = $2
        AND repo_slug = $3
        AND pr_number = $4
    `,
    [key.vcsProvider, key.workspace, key.repoSlug, key.prNumber],
  );
  return rows[0] ?? null;
}

/**
 * Lazily create-or-update the single pause row for a PR (D-01). On first call the row is INSERTed;
 * on subsequent calls ON CONFLICT DO UPDATE mutates the SAME row in place, so both pause and resume
 * flow through this one setter and never create a duplicate row. `pausedBy` receives the actor's
 * immutable account_id (NREG-02), never a username. `paused_at` records the time of the last
 * state change. Fully parameterized; no string interpolation.
 */
export async function upsertPrReviewState(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  key: PrReviewStateKey,
  state: { paused: boolean; pausedBy: string | null },
): Promise<PrReviewStateRow> {
  const rows = await queryRows<PrReviewStateRow>(
    env,
    `
      INSERT INTO pr_review_state (vcs_provider, workspace, repo_slug, pr_number, paused, paused_by, paused_at)
      VALUES ($1, $2, $3, $4, $5, $6, now())
      ON CONFLICT (vcs_provider, workspace, repo_slug, pr_number) DO UPDATE SET
        paused = EXCLUDED.paused,
        paused_by = EXCLUDED.paused_by,
        paused_at = EXCLUDED.paused_at
      RETURNING *
    `,
    [key.vcsProvider, key.workspace, key.repoSlug, key.prNumber, state.paused, state.pausedBy],
  );
  return rows[0];
}

/**
 * Convenience wrapper: pause a PR's review, attributing it to the actor's immutable account_id.
 * Lazily creates the row on first pause (via upsertPrReviewState).
 */
export async function markPrPaused(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  key: PrReviewStateKey,
  pausedByAccountId: string,
): Promise<PrReviewStateRow> {
  return upsertPrReviewState(env, key, { paused: true, pausedBy: pausedByAccountId });
}

/**
 * Convenience wrapper: resume a PR's review.
 *
 * IN-02: this is an UPDATE-ONLY operation, deliberately NOT routed through upsertPrReviewState.
 * Routing resume through the upsert INSERTed a spurious `paused=false` row for a never-paused PR
 * (breaking the "no row until the first pause" lazy-creation invariant, and materializing a
 * `paused=false` row where callers expect `null`), and overwrote `paused_by` with the RESUMER --
 * leaving the column named `paused_by` holding the actor who un-paused rather than the pauser.
 *
 * Corrected behavior:
 *   - No existing row  -> no-op, returns `null` (never creates a row).
 *   - Existing row     -> clears `paused` in place WITHOUT clobbering `paused_by`, which by the
 *                         module's NREG-02 intent records the immutable account_id of the PAUSER.
 *
 * `resumedByAccountId` is accepted for call-site symmetry with `markPrPaused` and forward
 * compatibility, but is intentionally NOT persisted: preserving the resumer's identity through a
 * resume would require a separate `resumed_by`/`last_actor` column (a deferred follow-up migration),
 * not overwriting the pauser's `paused_by`. Fully parameterized; no string interpolation.
 */
export async function markPrResumed(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  key: PrReviewStateKey,
  resumedByAccountId: string,
): Promise<PrReviewStateRow | null> {
  void resumedByAccountId;
  const rows = await queryRows<PrReviewStateRow>(
    env,
    `
      UPDATE pr_review_state
      SET paused = false,
          paused_at = now()
      WHERE vcs_provider = $1
        AND workspace = $2
        AND repo_slug = $3
        AND pr_number = $4
      RETURNING *
    `,
    [key.vcsProvider, key.workspace, key.repoSlug, key.prNumber],
  );
  return rows[0] ?? null;
}
