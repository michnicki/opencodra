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
// 05-04 widening: this helper is now provider-safe end-to-end. It threads an `effectiveProvider =
// input.provider ?? reviewRequest.repositoryVcsProvider ?? 'github'` value through
// findExistingJobForHead + supersedeOlderJobs, closing the Phase-3 deferred item (REVIEW
// finding 3 of Phase 3) that a Bitbucket concrete job would have been mis-attributed to a
// GitHub repo row. The default falls back to 'github' byte-identically when the caller passes
// neither -- the GitHub-only caller (tests 1-5 in test/webhook-ingest.spec.ts) stays
// NREG-02 byte-identical because the effective value 'github' produces the same SQL as the
// pre-widening no-arg path.

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

  // 05-04 widening (D-02 / Phase-3 deferred item closure): the effective provider threads
  // into findExistingJobForHead + supersedeOlderJobs + the queue message's optional
  // `provider` field. The chain is deterministic: explicit input.provider wins, then the
  // widened reviewRequest.repositoryVcsProvider (set by the Bitbucket route), finally
  // 'github' as the default. The no-arg GitHub caller (tests 1-5 in test/webhook-ingest.spec.ts)
  // never sets either; effectiveProvider resolves to 'github' byte-identically.
  const effectiveProvider = input.provider ?? reviewRequest?.repositoryVcsProvider ?? 'github' as const;

  // Preserve the exact branch condition from the pre-extraction route (Pitfall 2) -- do not
  // narrow `reviewRequest` to non-null here.
  if (reviewRequest?.commitSha && reviewRequest.baseSha) {
    const existingJob = await findExistingJobForHead(env, {
      owner: reviewRequest.owner,
      repo: reviewRequest.repo,
      prNumber: reviewRequest.prNumber,
      commitSha: reviewRequest.commitSha,
      trigger: reviewRequest.trigger,
      vcsProvider: effectiveProvider,
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
      // Store the inserted job under the SAME provider used for dedupe/supersede above. Previously
      // vcsProvider was forwarded only when reviewRequest.repositoryVcsProvider was set, so an
      // explicit input.provider (with repositoryVcsProvider unset) would dedupe/supersede as one
      // provider while the row was stored under the default 'github' -- a split-provider row.
      // Passing effectiveProvider closes that gap. The GitHub path stays byte-identical: passing
      // vcsProvider: 'github' explicitly is equivalent to leaving it unset, because
      // getOrCreateRepository does `input.vcsProvider ?? 'github'` and its GitHub branch never
      // reads workspace (confirmed against db/repositories.ts).
      vcsProvider: effectiveProvider,
      workspace: reviewRequest.repositoryWorkspace ?? null,
    });

    await supersedeOlderJobs(env, {
      installationId: reviewRequest.installationId,
      owner: reviewRequest.owner,
      repo: reviewRequest.repo,
      prNumber: reviewRequest.prNumber,
      newJobId: job.id,
      vcsProvider: effectiveProvider,
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
    } else if (effectiveProvider !== 'github') {
      // 05-04 widening: when the call came from the Bitbucket route (which threads provider
      // through reviewRequest.repositoryVcsProvider without setting input.provider), still
      // attach `provider: 'bitbucket'` to the queue message so downstream consumers (workflow /
      // runReviewJob) can branch. The GitHub no-arg path leaves the key absent (existing
      // behavior, preserved by NREG-02).
      message.provider = effectiveProvider;
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
  } else if (effectiveProvider !== 'github') {
    eventMessage.provider = effectiveProvider;
  }
  await env.REVIEW_QUEUE.send(eventMessage);

  return { outcome: 'queued_event' };
}
