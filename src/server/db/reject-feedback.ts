import type { AppBindings } from '@server/env';
import type { VcsProvider } from '@shared/schema';
import { queryRows } from './client';

/**
 * D-09 / CMD-05 (Phase 11): typed accessor for the `reject_feedback` table (migration 009) --
 * capture-only storage of a structured negative-feedback signal when a user replies `reject` under an
 * inline finding. Feeds the future v2 LRN-01 learned-rule synthesis; this milestone captures the
 * input only, no synthesis.
 *
 * One module per domain (mirrors db/pr-review-state.ts). No consumer is wired this plan; the command
 * dispatcher writer lands in a later Phase 11 plan.
 *
 * Every statement is parameterized via queryRows -- NO string interpolation of values (V5 Input
 * Validation / SQLi mitigation, T-11-01-1). `rejected_by` stores the actor's IMMUTABLE account_id /
 * numeric id, NEVER a mutable username/handle (NREG-02, T-11-01-2).
 */

export type RejectFeedbackRow = {
  id: string;
  vcs_provider: VcsProvider;
  workspace: string;
  repo_slug: string;
  pr_number: number;
  finding_ref: string;
  reason: string | null;
  rejected_by: string;
  source_comment_ref: string;
  created_at: string;
};

/**
 * Write one reject-feedback row, idempotent on (vcs_provider, source_comment_ref) via ON CONFLICT DO
 * NOTHING -- a crash-before-ack queue replay of the same reject reply comment does NOT double-insert
 * (REVIEW: Codex 11-01 MED). Returns the inserted row, or null when the insert was a no-op (either a
 * duplicate source_comment_ref, or a capture-skip because finding_ref / source_comment_ref is empty).
 *
 * A missing finding_ref (no resolvable parent finding, CMD-05 edge) or source_comment_ref is a
 * capture-SKIP, not an error: the caller gets null and no row is written. `reason` (the reply body)
 * may be null.
 */
export async function insertRejectFeedback(
  env: Pick<AppBindings, 'HYPERDRIVE'>,
  input: {
    vcsProvider: VcsProvider;
    workspace: string;
    repoSlug: string;
    prNumber: number;
    findingRef: string;
    reason: string | null;
    rejectedBy: string;
    sourceCommentRef: string;
  },
): Promise<RejectFeedbackRow | null> {
  // CMD-05 edge: a reject with no resolvable finding_ref (no parent comment) -- or no source comment
  // ref to key idempotency on -- is a capture-skip, not a throw.
  if (!input.findingRef || !input.sourceCommentRef) {
    return null;
  }

  const rows = await queryRows<RejectFeedbackRow>(
    env,
    `
      INSERT INTO reject_feedback
        (vcs_provider, workspace, repo_slug, pr_number, finding_ref, reason, rejected_by, source_comment_ref)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (vcs_provider, source_comment_ref) DO NOTHING
      RETURNING *
    `,
    [
      input.vcsProvider,
      input.workspace,
      input.repoSlug,
      input.prNumber,
      input.findingRef,
      input.reason,
      input.rejectedBy,
      input.sourceCommentRef,
    ],
  );

  return rows[0] ?? null;
}
