import { describe, it, expect, beforeEach } from 'vitest';
import { insertRejectFeedback } from '@server/db/reject-feedback';
import { queryRows } from '@server/db/client';
import { createTestEnv, hasConfiguredTestDatabaseUrl } from './helpers';

// CMD-05 / D-09: prove the reject-capture accessor. Idempotent on (vcs_provider, source_comment_ref)
// so a crash-before-ack queue replay does NOT double-insert (REVIEW: Codex 11-01 MED); rejected_by
// stores the IMMUTABLE account_id (NREG-02); a reject with an empty finding_ref OR source_comment_ref
// is a capture-skip (no row, no throw). Runs against the migrated TEST_DATABASE_URL (migration 009
// applied by `npm test`).
const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;

const base = {
  vcsProvider: 'github' as const,
  workspace: 'test-owner',
  repoSlug: 'repo-reject',
  prNumber: 21,
};

async function countRef(env: ReturnType<typeof createTestEnv>, sourceCommentRef: string): Promise<number> {
  const [{ n }] = await queryRows<{ n: string }>(
    env,
    `SELECT COUNT(*)::text AS n FROM reject_feedback WHERE vcs_provider = $1 AND source_comment_ref = $2`,
    ['github', sourceCommentRef],
  );
  return Number(n);
}

dbDescribe('reject_feedback capture (CMD-05 / D-09)', () => {
  const env = createTestEnv();

  beforeEach(async () => {
    await queryRows(env, `TRUNCATE reject_feedback`);
  });

  it('writes one row with rejected_by = the immutable id (never a username)', async () => {
    const row = await insertRejectFeedback(env, {
      ...base,
      findingRef: '21:1001',
      reason: 'This is a false positive',
      rejectedBy: 'account-id-immutable-abc',
      sourceCommentRef: '21:2002',
    });

    expect(row).not.toBeNull();
    expect(row!.rejected_by).toBe('account-id-immutable-abc');
    expect(row!.finding_ref).toBe('21:1001');
    expect(row!.reason).toBe('This is a false positive');
    expect(row!.source_comment_ref).toBe('21:2002');
  });

  it('allows a null reason (reply body may be absent)', async () => {
    const row = await insertRejectFeedback(env, {
      ...base,
      findingRef: '21:1003',
      reason: null,
      rejectedBy: 'account-id-2',
      sourceCommentRef: '21:2003',
    });
    expect(row).not.toBeNull();
    expect(row!.reason).toBeNull();
  });

  it('is idempotent on (vcs_provider, source_comment_ref): a replay inserts no second row', async () => {
    const first = await insertRejectFeedback(env, {
      ...base,
      findingRef: '21:1004',
      reason: 'reject',
      rejectedBy: 'account-id-3',
      sourceCommentRef: '21:2004',
    });
    expect(first).not.toBeNull();

    // Crash-before-ack replay of the same reject reply comment.
    const replay = await insertRejectFeedback(env, {
      ...base,
      findingRef: '21:1004',
      reason: 'reject',
      rejectedBy: 'account-id-3',
      sourceCommentRef: '21:2004',
    });
    expect(replay).toBeNull();

    expect(await countRef(env, '21:2004')).toBe(1);
  });

  it('writes no row when finding_ref is empty (capture-skip, not a throw)', async () => {
    const row = await insertRejectFeedback(env, {
      ...base,
      findingRef: '',
      reason: 'reject',
      rejectedBy: 'account-id-4',
      sourceCommentRef: '21:2005',
    });
    expect(row).toBeNull();
    expect(await countRef(env, '21:2005')).toBe(0);
  });

  it('writes no row when source_comment_ref is empty (capture-skip, not a throw)', async () => {
    const row = await insertRejectFeedback(env, {
      ...base,
      findingRef: '21:1006',
      reason: 'reject',
      rejectedBy: 'account-id-5',
      sourceCommentRef: '',
    });
    expect(row).toBeNull();
  });
});
