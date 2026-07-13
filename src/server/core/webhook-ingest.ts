import type { AppBindings } from '@server/env';
import type { ReviewRequest } from '@server/core/review';
import { findExistingJobForHead, insertJob, supersedeOlderJobs } from '@server/db/jobs';
import type { JobSummary, ReviewJobMessage, RepoConfig } from '@shared/schema';

// Provider-agnostic ingest orchestration extracted from routes/webhook.ts:72-131 (D-03). This
// file must contain no GitHub-specific payload parsing, signature verification, or webhook
// header handling -- those all stay in the GitHub route. The route parses its provider-specific
// inputs first and passes an already-parsed `ReviewRequest | null` (or, for a future Bitbucket
// caller, an equivalent shape) into this helper.
//
// DEFERRED TO PHASE 5 (REVIEW finding 3): this helper extracts provider-NEUTRAL ingest
// orchestration ONLY. insertJob -> getOrCreateRepository defaults an omitted provider to
// 'github' (db/repositories.ts), and findExistingJobForHead / supersedeOlderJobs filter without
// a provider column (db/jobs.ts). That means this helper is NOT yet safe for Bitbucket
// concrete-job identity -- Phase 5 MUST make insert/dedup/supersede/repo-config-lookup
// provider-aware before any Bitbucket concrete job routes through this helper.

export type WebhookIngestInput = {
  reviewRequest: ReviewRequest | null;
  configSnapshot: RepoConfig;
  deliveryId: string;
  requestId: string | undefined;
  eventName: string;
  provider?: 'github' | 'bitbucket';
};

export type WebhookIngestResult =
  | { outcome: 'duplicate'; job: JobSummary }
  | { outcome: 'queued'; job: JobSummary }
  | { outcome: 'queued_event' };

export async function ingestReviewWebhookEvent(
  env: Pick<AppBindings, 'HYPERDRIVE' | 'APP_KV' | 'REVIEW_QUEUE'>,
  input: WebhookIngestInput,
): Promise<WebhookIngestResult> {
  const { reviewRequest } = input;

  // Preserve the exact branch condition from the pre-extraction route (Pitfall 2) -- do not
  // narrow `reviewRequest` to non-null here.
  if (reviewRequest?.commitSha && reviewRequest.baseSha) {
    const existingJob = await findExistingJobForHead(env, {
      owner: reviewRequest.owner,
      repo: reviewRequest.repo,
      prNumber: reviewRequest.prNumber,
      commitSha: reviewRequest.commitSha,
      trigger: reviewRequest.trigger,
    });

    if (existingJob) {
      return { outcome: 'duplicate', job: existingJob };
    }

    const job = await insertJob(env, {
      installationId: reviewRequest.installationId,
      owner: reviewRequest.owner,
      repo: reviewRequest.repo,
      prNumber: reviewRequest.prNumber,
      prTitle: reviewRequest.prTitle,
      prAuthor: reviewRequest.prAuthor,
      commitSha: reviewRequest.commitSha,
      baseSha: reviewRequest.baseSha,
      trigger: reviewRequest.trigger,
      headRef: reviewRequest.headRef,
      baseRef: reviewRequest.baseRef,
      configSnapshot: input.configSnapshot,
    });

    await supersedeOlderJobs(env, {
      installationId: reviewRequest.installationId,
      owner: reviewRequest.owner,
      repo: reviewRequest.repo,
      prNumber: reviewRequest.prNumber,
      newJobId: job.id,
    });

    const message: ReviewJobMessage = {
      jobId: job.id,
      deliveryId: input.deliveryId,
      phase: 'prepare',
      requestId: input.requestId,
    };
    // Pitfall 1 / D-02: only attach `provider` when explicitly given -- never spread/default the
    // key unconditionally, or the byte-identity guarantee for the existing GitHub-only caller
    // (which passes no `provider`) breaks.
    if (input.provider !== undefined) {
      message.provider = input.provider;
    }
    await env.REVIEW_QUEUE.send(message);

    return { outcome: 'queued', job };
  }

  // D-04: events that do not produce a concrete job (e.g. PR close cleanup, mention events that
  // need PR lookup) are folded into this generic "no concrete job -> enqueue event" branch.
  const eventMessage: ReviewJobMessage = {
    deliveryId: input.deliveryId,
    eventName: input.eventName,
    requestId: input.requestId,
  };
  if (input.provider !== undefined) {
    eventMessage.provider = input.provider;
  }
  await env.REVIEW_QUEUE.send(eventMessage);

  return { outcome: 'queued_event' };
}
