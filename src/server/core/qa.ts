// Phase 11, Plan 11-04 — the lightweight, read-only, rate-limited PR Q&A handler (QA-01/QA-02).
//
// answerQuestion answers a reviewer's free-form (non-command) mention grounded ONLY in the PR title,
// description, and diff, and posts a single reply. It is a NON-Workflow call (~4 subrequests:
// getPullRequest + getPullRequestDiff + one model call + createPrComment) invoked directly by the
// queue consumer (Plan 06) for kind='qa' messages with a provider constructed via
// VcsService.forProvider (Plan 02 jobless factory).
//
// READ-ONLY (QA-02 / T-11-04-4): the ONLY side effects are the single createPrComment reply and the
// APP_KV rate-limit counter. No job creation, no pause/resume, no status-check or label mutation, no
// DB write. The whole path is gated behind review.interactive.qa.enabled (default false, NREG-01).

import type { AppBindings } from '../env';
import type { RepoConfig } from '@shared/schema';
import type { VcsProvider } from '../vcs/types';
import { ModelService } from '../services/model';
import { buildQaPrompt } from '../prompts/qa';
import { parseUnifiedDiff, filterReviewableFiles, type FileDiff } from './diff';
import { logger } from './logger';

// The classified Q&A context handed to answerQuestion. `provider` is the VCS platform name (used
// only to namespace the rate-limit key); the actual provider client is injected separately so this
// handler never constructs credentials itself (Plan 02/06 own that).
export type QaContext = {
  provider: 'github' | 'bitbucket';
  workspace: string;
  repo: string;
  prNumber: number;
  question: string;
  authorId: string;
};

export type QaResult = { answered: boolean; reason?: string };

// Rate-limit KV TTL. One hour (seconds); the key already embeds the hour bucket so a fresh bucket
// starts a fresh count and the TTL just garbage-collects the previous bucket's key.
const QA_RATE_TTL_SECONDS = 3_600;

// Encode a rate-limit key component so a workspace/repo containing the ':' , '/' or '#' delimiters
// cannot collide with a different PR's key (REVIEW: OpenCode/Antigravity KV-key note). encodeURIComponent
// escapes all three delimiters, so the composed key is unambiguous.
function encodeKeyComponent(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Best-effort per-PR hourly rate limit backed by an APP_KV counter keyed
 * `qa-rate:{provider}:{workspace}/{repo}#{pr}:{hourBucket}`. Returns true when the call is within
 * the cap (and records the increment), false when the cap is already reached (silent-drop, D-07).
 *
 * The read-then-write is NOT atomic — under a concurrent burst two invocations could each read the
 * same count and both write count+1. That is acceptable here because the review queue runs with
 * max_concurrency:1, so Q&A invocations for the same PR are effectively serialized; the worst case
 * under a rare race is one extra reply, never a privileged side effect (documented disposition,
 * REVIEW: Codex 11-04 LOW).
 */
async function checkAndIncrementRateLimit(
  env: Pick<AppBindings, 'APP_KV'>,
  ctx: QaContext,
  cap: number,
): Promise<boolean> {
  const hourBucket = Math.floor(Date.now() / (QA_RATE_TTL_SECONDS * 1_000));
  const key = `qa-rate:${encodeKeyComponent(ctx.provider)}:${encodeKeyComponent(ctx.workspace)}/${encodeKeyComponent(
    ctx.repo,
  )}#${ctx.prNumber}:${hourBucket}`;

  let count = 0;
  try {
    const raw = await env.APP_KV.get(key);
    if (raw) {
      const parsed = parseInt(raw, 10);
      if (Number.isFinite(parsed) && parsed > 0) count = parsed;
    }
  } catch (error) {
    // A KV read failure should not wedge Q&A; treat it as "no prior calls" and proceed. The write
    // below will still attempt to record the increment.
    logger.warn('Q&A rate-limit KV read failed; proceeding as if uncounted', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Boundary: allow the Nth call (count 0..cap-1) and drop the (N+1)th (count === cap).
  if (count >= cap) {
    return false;
  }

  try {
    await env.APP_KV.put(key, String(count + 1), { expirationTtl: QA_RATE_TTL_SECONDS });
  } catch (error) {
    // Best-effort: a failed increment means this call may not be counted, but we still answer.
    logger.warn('Q&A rate-limit KV write failed; answering without recording the increment', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return true;
}

/**
 * Answer a free-form PR question. READ-ONLY except the single reply + the KV rate counter.
 *
 * Order of operations (rate-limit FIRST so an over-limit question costs no model call):
 *   1. Gate on config.review.interactive.qa.enabled — return early if off (NREG-01).
 *   2. Enforce the config-driven per-PR hourly KV rate limit — silent no-op if exceeded (D-07).
 *   3. Fetch the PR + diff via the INJECTED provider; a diff-fetch failure degrades to an empty
 *      diff so the model still answers scope-honestly (QA-01/D-04) rather than erroring.
 *   4. Build the capped, fenced prompt (buildQaPrompt) and run ModelService.answerPrQuestion — the
 *      single public prose path; this handler NEVER touches the private selectModel/callResolvedModel.
 *   5. Post the answer via provider.createPrComment.
 */
export async function answerQuestion(
  env: AppBindings,
  provider: VcsProvider,
  ctx: QaContext,
  config: RepoConfig,
): Promise<QaResult> {
  if (!config.review.interactive.qa.enabled) {
    return { answered: false, reason: 'disabled' };
  }

  const cap = config.review.interactive.qa.rate_limit_per_hour;
  const allowed = await checkAndIncrementRateLimit(env, ctx, cap);
  if (!allowed) {
    logger.info('Q&A rate limit reached for PR; dropping question silently', {
      provider: ctx.provider,
      workspace: ctx.workspace,
      repo: ctx.repo,
      prNumber: ctx.prNumber,
    });
    return { answered: false, reason: 'rate_limited' };
  }

  // Fetch PR metadata. If this fails we cannot answer at all — let it propagate to the caller.
  const pr = await provider.getPullRequest(ctx.workspace, ctx.repo, ctx.prNumber);

  // Fetch + parse the diff. An empty or unavailable diff is NOT fatal: the model still answers from
  // the PR title/description and states the scope limit (QA-01/D-04 scope honesty).
  let files: FileDiff[] = [];
  try {
    const rawDiff = await provider.getPullRequestDiff(ctx.workspace, ctx.repo, ctx.prNumber);
    files = filterReviewableFiles(parseUnifiedDiff(rawDiff, config.review), config.review);
  } catch (error) {
    logger.warn('Q&A diff fetch failed; answering from PR metadata only (scope-honest)', {
      error: error instanceof Error ? error.message : String(error),
      prNumber: ctx.prNumber,
    });
    files = [];
  }

  const { systemPrompt, userPrompt } = buildQaPrompt({
    question: ctx.question,
    prTitle: pr.title,
    prBody: pr.body,
    files,
    config: config.review,
  });

  const modelService = new ModelService(env);
  const answer = await modelService.answerPrQuestion({ systemPrompt, userPrompt, config });

  await provider.createPrComment(ctx.workspace, ctx.repo, ctx.prNumber, answer);

  return { answered: true };
}
