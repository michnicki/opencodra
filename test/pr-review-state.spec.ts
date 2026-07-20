import { describe, it, expect } from 'vitest';
import {
  getPrReviewState,
  markPrPaused,
  markPrResumed,
  type PrReviewStateKey,
} from '@server/db/pr-review-state';
import { queryRows } from '@server/db/client';
import { createTestEnv, hasConfiguredTestDatabaseUrl } from './helpers';

// SC1 (pause portion): prove the pr_review_state accessors behave as the Phase 11 pause substrate
// requires -- null when the PR has never been paused (lazy creation), one row per PR keyed on the
// immutable account_id, and (REVIEW FIX, Codex HIGH #2) exactly one row per GitHub PR because the
// NOT NULL canonical workspace + UNIQUE(vcs_provider, workspace, repo_slug, pr_number) enforces
// D-01's one-row-per-PR even for GitHub. Runs against the migrated TEST_DATABASE_URL (007 applied by
// `npm test`).
const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;

// Unique per-test tuples so parallel-safe repeat runs never collide on the UNIQUE key.
function githubKey(suffix: string): PrReviewStateKey {
  return { vcsProvider: 'github', workspace: 'test-owner', repoSlug: `repo-${suffix}`, prNumber: 7 };
}

async function countRows(env: ReturnType<typeof createTestEnv>, key: PrReviewStateKey): Promise<number> {
  const rows = await queryRows<{ n: string }>(
    env,
    `
      SELECT COUNT(*)::text AS n
      FROM pr_review_state
      WHERE vcs_provider = $1 AND workspace = $2 AND repo_slug = $3 AND pr_number = $4
    `,
    [key.vcsProvider, key.workspace, key.repoSlug, key.prNumber],
  );
  return Number(rows[0].n);
}

dbDescribe('pr_review_state pause accessors (SC1 pause portion)', () => {
  const env = createTestEnv();

  it('returns null for a never-paused PR (no row until first pause)', async () => {
    const key = githubKey(`never-${Date.now()}`);
    expect(await getPrReviewState(env, key)).toBeNull();
  });

  it('pauses with the immutable account_id and lazily creates the row', async () => {
    const key = githubKey(`pause-${Date.now()}`);
    const accountId = 'account-id-abc-123';

    await markPrPaused(env, key, accountId);

    const state = await getPrReviewState(env, key);
    expect(state).not.toBeNull();
    expect(state!.paused).toBe(true);
    expect(state!.paused_by).toBe(accountId);
  });

  it('re-pausing the same tuple updates in place (single row, lazy creation + ON CONFLICT)', async () => {
    const key = githubKey(`repause-${Date.now()}`);

    await markPrPaused(env, key, 'account-first');
    await markPrPaused(env, key, 'account-second');

    expect(await countRows(env, key)).toBe(1);
    const state = await getPrReviewState(env, key);
    expect(state!.paused).toBe(true);
    expect(state!.paused_by).toBe('account-second');
  });

  it('resume clears paused in place WITHOUT clobbering paused_by (IN-02)', async () => {
    const key = githubKey(`resume-${Date.now()}`);

    await markPrPaused(env, key, 'account-pauser');
    const resumed = await markPrResumed(env, key, 'account-resumer');

    // Single row, cleared in place.
    expect(await countRows(env, key)).toBe(1);
    expect(resumed).not.toBeNull();
    expect(resumed!.paused).toBe(false);
    const state = await getPrReviewState(env, key);
    expect(state!.paused).toBe(false);
    // IN-02: paused_by preserves the PAUSER's immutable account_id (NREG-02 intent), NOT the
    // resumer -- the previous upsert-based implementation overwrote it with 'account-resumer'.
    expect(state!.paused_by).toBe('account-pauser');
  });

  it('resuming a never-paused PR is a no-op: no row is created and null is returned (IN-02)', async () => {
    const key = githubKey(`resume-noop-${Date.now()}`);

    // IN-02: resume must NOT route through the upsert (which would INSERT a spurious paused=false
    // row and break the "no row until first pause" lazy-creation invariant).
    const resumed = await markPrResumed(env, key, 'account-resumer');

    expect(resumed).toBeNull();
    expect(await countRows(env, key)).toBe(0);
    expect(await getPrReviewState(env, key)).toBeNull();
  });

  it('two pause attempts on the same GitHub PR tuple yield exactly one row (D-01 one-row-per-PR for GitHub)', async () => {
    // REVIEW FIX (Codex HIGH #2): a nullable workspace would let Postgres treat the two GitHub rows
    // as distinct under the default UNIQUE and permit a duplicate. The NOT NULL canonical workspace
    // (owner/login) + UNIQUE(vcs_provider, workspace, repo_slug, pr_number) collapses both attempts
    // onto one row.
    const key = githubKey(`onerow-${Date.now()}`);

    await markPrPaused(env, key, 'account-a');
    await markPrPaused(env, key, 'account-b');

    expect(await countRows(env, key)).toBe(1);
  });
});
