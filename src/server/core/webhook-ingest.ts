import type { AppBindings } from '@server/env';
import type { ReviewRequest } from '@server/core/review';
import { findExistingJobForHead, insertJob, supersedeOlderJobs } from '@server/db/jobs';
import type { JobSummary, ReviewJobMessage, RepoConfig } from '@shared/schema';
import type { CommentContext } from '@server/core/commands';
import { authorizeActor, classifyComment } from '@server/core/commands';
import { VcsService } from '@server/services/vcs';
import { createGithubBotIdentityResolver } from '@server/core/github';
import { createBitbucketBotIdentityResolver } from '@server/core/bitbucket';
import type { BotIdentityResolver } from '@server/core/bot-identity';
import { getPrReviewState, type PrReviewStateKey } from '@server/db/pr-review-state';
import { listSkippedFilesForHead } from '@server/db/skipped-files';

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
//
// 11-06 widening (Phase 11 integration seam): additively carries an optional `commentContext`
// (a PR comment classified by Plan 03) + `prBody`. When a comment is present this helper runs an
// EXCLUSIVE classification branch (self-filter → command/qa/ignored) that returns for EVERY
// outcome and NEVER falls through to the legacy queued_event → Workflow path (T-11-06-5). When it
// is absent every existing caller (GitHub route, Bitbucket route, tests 1-5) compiles and behaves
// byte-identically (NREG-01). A commands-gated pause/ignore gate short-circuits AUTO reviews only;
// an explicit review command (which arrives via commentContext, trigger !== 'auto') bypasses it.

export type WebhookIngestInput = {
  reviewRequest: ReviewRequest | null;
  configSnapshot: RepoConfig;
  deliveryId: string;
  requestId: string | undefined;
  eventName: string;
  provider?: 'github' | 'bitbucket';
  // Phase 11 Plan 06 (additive, NREG-01): the provider-agnostic classified-comment context the route
  // builds for a PR COMMENT event. Present => this helper runs the EXCLUSIVE classification branch
  // instead of the auto-review path. Absent for every pre-Phase-11 caller => byte-identical behavior.
  commentContext?: CommentContext;
  // Phase 11 Plan 06 (additive): the PR description, threaded on AUTO events so the commands-gated
  // ignore gate can detect a leading `<mention> ignore` directive in the PR body (CMD-06). Absent =>
  // the ignore gate finds nothing to parse and does not short-circuit.
  prBody?: string;
};

export type WebhookIngestResult =
  | { outcome: 'duplicate'; job: JobSummary }
  | { outcome: 'queued'; job: JobSummary }
  | { outcome: 'queued_event' }
  // 11-06: auto-review short-circuits (commands-gated). No job, no supersede, no enqueue.
  | { outcome: 'ignored_paused' }
  | { outcome: 'ignored_directive' }
  // 11-06: exclusive comment-classification outcomes (never a queued_event fall-through).
  | { outcome: 'ignored_comment'; reason: string }
  | { outcome: 'command_enqueued' }
  | { outcome: 'qa_enqueued' };

/**
 * Build the `pr_review_state` pause key for an AUTO review request under the effective provider,
 * using the SAME workspace convention the table expects (GitHub owner/login, Bitbucket workspace
 * slug — non-null). Mirrors `core/commands.ts::pauseKey`, but derives the workspace from the
 * ReviewRequest rather than a CommentContext.
 */
function autoPauseKey(
  effectiveProvider: 'github' | 'bitbucket',
  reviewRequest: ReviewRequest,
): PrReviewStateKey {
  return {
    vcsProvider: effectiveProvider,
    workspace: reviewRequest.repositoryWorkspace ?? reviewRequest.owner,
    repoSlug: reviewRequest.repo,
    prNumber: reviewRequest.prNumber,
  };
}

const TRAILING_PUNCT = /[?.!,;:]+$/;

/**
 * Detect a leading `<mention> ignore` directive anywhere in the PR body (CMD-06). Matched with
 * `String.startsWith` after trimming leading whitespace on each line (never a constructed RegExp over
 * the untrusted mention), with a boundary check so `@codra-appignore` is not a match. Only the FIRST
 * token after the mention is inspected — a longer sentence beginning with the mention is not a
 * directive. Returns false when there is no body or mention-triggering is disabled.
 */
function hasLeadingIgnoreDirective(
  prBody: string | undefined,
  mentionTrigger: string | false,
): boolean {
  if (!prBody || typeof mentionTrigger !== 'string') {
    return false;
  }
  for (const rawLine of prBody.split('\n')) {
    const line = rawLine.replace(/^\s+/, '');
    if (!line.startsWith(mentionTrigger)) {
      continue;
    }
    const after = line.slice(mentionTrigger.length);
    // Boundary: require whitespace (or end) after the mention so '@codra-appignore' is not a match.
    if (after !== '' && !/^\s/.test(after)) {
      continue;
    }
    const remainder = after.trim().replace(/\s+/g, ' ').toLowerCase();
    const firstToken = remainder.split(' ')[0]?.replace(TRAILING_PUNCT, '');
    if (firstToken === 'ignore') {
      return true;
    }
  }
  return false;
}

export async function ingestReviewWebhookEvent(
  env: AppBindings,
  input: WebhookIngestInput,
): Promise<WebhookIngestResult> {
  const { reviewRequest } = input;
  const config = input.configSnapshot;

  // 05-04 widening (D-02 / Phase-3 deferred item closure): the effective provider threads
  // into findExistingJobForHead + supersedeOlderJobs + the queue message's optional
  // `provider` field. The chain is deterministic: explicit input.provider wins, then the
  // widened reviewRequest.repositoryVcsProvider (set by the Bitbucket route), finally
  // 'github' as the default. The no-arg GitHub caller (tests 1-5 in test/webhook-ingest.spec.ts)
  // never sets either; effectiveProvider resolves to 'github' byte-identically.
  const effectiveProvider = input.provider ?? reviewRequest?.repositoryVcsProvider ?? ('github' as const);

  const commandsEnabled = config.review.interactive.commands.enabled;
  const qaEnabled = config.review.interactive.qa.enabled;

  // ── EXCLUSIVE COMMENT-CLASSIFICATION BRANCH (11-06, T-11-06-5). When a comment is present this
  //    branch ALWAYS returns — a classified command/qa/ignored comment must NEVER fall through to the
  //    generic queued_event → Workflow path (the echo-loop / disabled-path regression fires
  //    otherwise). classifyComment is only invoked when a feature is on; with BOTH off the comment is
  //    inert (ignored) and still consumes no queue message.
  if (input.commentContext) {
    if (!commandsEnabled && !qaEnabled) {
      return { outcome: 'ignored_comment', reason: 'feature_disabled' };
    }
    return handleCommentEvent(env, input, effectiveProvider);
  }

  // ── COMMANDS-GATED PAUSE / IGNORE AUTO-GATE (11-06, T-11-06-4/6, D-08). Runs ONLY when the
  //    commands feature is enabled AND this is an AUTO-triggered review; an explicit review command
  //    arrives via commentContext (handled above) and therefore bypasses both gates. With commands
  //    OFF the gate is skipped entirely (no DB read) so an @bot ignore body cannot suppress an auto
  //    review and the path stays byte-identical (NREG-01).
  if (commandsEnabled && reviewRequest && reviewRequest.trigger === 'auto') {
    const pauseState = await getPrReviewState(env, autoPauseKey(effectiveProvider, reviewRequest));
    if (pauseState?.paused) {
      return { outcome: 'ignored_paused' };
    }
    if (hasLeadingIgnoreDirective(input.prBody, config.review.mention_trigger)) {
      return { outcome: 'ignored_directive' };
    }
  }

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

/**
 * The EXCLUSIVE PR-comment classification branch (11-06). Constructs the jobless provider +
 * bot-identity resolver via the Plan 02 factory, classifies the comment (self-filter FIRST, D-03),
 * and returns for every outcome:
 *   - ignored               → ignored_comment (no queue send)
 *   - command review/-rest   → authorize → hydrate PR SHAs → rerun-insert → REVIEW_WORKFLOW review
 *   - command pause/…/reject → { kind:'command' } enqueue (consumer dispatches inline)
 *   - qa                     → { kind:'qa' } enqueue (consumer dispatches inline)
 *
 * Never falls through to the generic queued_event path (T-11-06-5).
 */
async function handleCommentEvent(
  env: AppBindings,
  input: WebhookIngestInput,
  effectiveProvider: 'github' | 'bitbucket',
): Promise<WebhookIngestResult> {
  const ctx = input.commentContext!;
  const config = input.configSnapshot;
  // GitHub needs an installationId to construct the provider + insert the job; Bitbucket carries
  // none (its per-repo credential is keyed on workspace/repo). The route threads it via the
  // mention-shaped reviewRequest for GitHub comment events.
  const installationId = input.reviewRequest?.installationId || undefined;

  // Construct the provider via the jobless factory (D-03) + the matching bot-identity resolver. The
  // resolver wraps the provider's own resolveBotUserIdentity so classifyComment's self-filter keys on
  // the bot's immutable accountId BEFORE any parse (echo-loop defense, T-11-06-1).
  const provider = await VcsService.forProvider(env, {
    provider: effectiveProvider,
    installationId,
    workspace: ctx.workspace,
    repo: ctx.repo,
  });
  const resolver: BotIdentityResolver =
    effectiveProvider === 'bitbucket'
      ? createBitbucketBotIdentityResolver(provider)
      : createGithubBotIdentityResolver(provider);

  const classified = await classifyComment(env, provider, resolver, ctx, config);

  // ── ignored: self_filtered / identity_unresolved / not_mention / feature_disabled → no queue send.
  if (classified.kind === 'ignored') {
    return { outcome: 'ignored_comment', reason: classified.reason };
  }

  // ── qa: independent of commands.enabled. Enqueue for inline dispatch (consumer builds the
  //    provider + calls answerQuestion). READ-ONLY path; no authorization gate.
  if (classified.kind === 'qa') {
    const message: ReviewJobMessage = {
      kind: 'qa',
      deliveryId: input.deliveryId,
      requestId: input.requestId,
      eventName: input.eventName,
      provider: effectiveProvider,
      owner: ctx.owner,
      repo: ctx.repo,
      prNumber: ctx.prNumber,
      interactive: {
        question: classified.question,
        authorId: ctx.authorId,
        authorLogin: ctx.authorLogin,
        body: ctx.body,
        workspace: ctx.workspace,
        // WR-01: carry the provider-safe config so the inline consumer never re-derives it via the
        // owner/repo collision path (critical for Bitbucket).
        configSnapshot: config,
      },
    };
    if (installationId) {
      message.installationId = installationId;
    }
    await env.REVIEW_QUEUE.send(message);
    return { outcome: 'qa_enqueued' };
  }

  const command = classified;

  // ── review / review-rest: authorize, hydrate the CURRENT PR metadata (comment events carry EMPTY
  //    SHAs), then insert a FRESH job via a rerun path (never findExistingJobForHead — it returns a
  //    terminal job as a duplicate and would swallow the explicit re-review, REVIEW: Codex 11-05).
  if (command.name === 'review' || command.name === 'review-rest') {
    const authorized = await authorizeActor(
      env,
      provider,
      ctx.owner,
      ctx.repo,
      ctx.authorId,
      ctx.authorLogin,
      config,
    );
    if (!authorized) {
      // D-07 silent ignore — no reply, no job.
      return { outcome: 'ignored_comment', reason: 'unauthorized' };
    }

    // Hydrate head/base SHAs + refs + title/author from the live PR (REVIEW: Codex/Antigravity #1).
    const pr = await provider.getPullRequest(ctx.workspace, ctx.repo, ctx.prNumber);

    const workspace = effectiveProvider === 'bitbucket' ? ctx.workspace : null;
    let scopeSourceJobId: string | null = null;

    if (command.name === 'review-rest') {
      // review-rest re-reviews exactly the files a prior full review skipped for size. If the source
      // skip set (by PR identity + current head) is empty, there is nothing to re-review — short
      // circuit BEFORE creating a job.
      const skipped = await listSkippedFilesForHead(env, {
        vcsProvider: effectiveProvider,
        workspace: ctx.workspace,
        repoSlug: ctx.repo,
        prNumber: ctx.prNumber,
        headSha: pr.headSha,
      });
      if (skipped.length === 0) {
        return { outcome: 'ignored_comment', reason: 'no_skipped_files' };
      }
      // Link the rest-scoped job to the source full-review job at this head (informational
      // provenance — getJobDiffFiles keys skips on PR identity + head, NOT on this id). This uses
      // findExistingJobForHead for LOOKUP ONLY (it returns the latest job at the head, i.e. the
      // source full review) — it is NOT the dedupe gate for the command review insert below, which
      // deliberately never dedupes (REVIEW: Codex 11-05 HIGH). Best-effort: null when the source was
      // not an auto review.
      const source = await findExistingJobForHead(env, {
        owner: ctx.owner,
        repo: ctx.repo,
        prNumber: ctx.prNumber,
        commitSha: pr.headSha,
        trigger: 'auto',
        vcsProvider: effectiveProvider,
      });
      scopeSourceJobId = source?.id ?? null;
    }

    const job = await insertJob(env, {
      installationId: installationId ?? '',
      owner: ctx.owner,
      repo: ctx.repo,
      prNumber: ctx.prNumber,
      prTitle: pr.title,
      prAuthor: pr.authorLogin,
      commitSha: pr.headSha,
      baseSha: pr.baseSha ?? '',
      trigger: 'mention',
      headRef: pr.headRef,
      baseRef: pr.baseRef,
      configSnapshot: config,
      vcsProvider: effectiveProvider,
      workspace,
      reviewScope: command.name === 'review' ? 'all' : 'rest',
      scopeSourceJobId,
    });

    await supersedeOlderJobs(env, {
      installationId,
      workspace: workspace ?? undefined,
      owner: ctx.owner,
      repo: ctx.repo,
      prNumber: ctx.prNumber,
      newJobId: job.id,
      vcsProvider: effectiveProvider,
    });

    // A review IS a Workflow review — enqueue a NO-KIND message so the consumer reaches
    // REVIEW_WORKFLOW.create byte-identically (NREG-01). The persisted job.review_scope drives
    // review-rest scoping (Plan 05 getJobDiffFiles), so nothing extra rides on the message.
    const message: ReviewJobMessage = {
      jobId: job.id,
      deliveryId: input.deliveryId,
      phase: 'prepare',
      requestId: input.requestId,
    };
    if (effectiveProvider !== 'github') {
      message.provider = effectiveProvider;
    }
    await env.REVIEW_QUEUE.send(message);
    return { outcome: 'queued', job };
  }

  // ── pause / resume / help / reject: enqueue a { kind:'command' } message for INLINE (non-Workflow)
  //    dispatch. body + workspace + authorId MUST ride along so the consumer rebuilds a complete
  //    CommentContext and reject persists reason=body idempotently (D-09).
  const message: ReviewJobMessage = {
    kind: 'command',
    deliveryId: input.deliveryId,
    requestId: input.requestId,
    eventName: input.eventName,
    provider: effectiveProvider,
    owner: ctx.owner,
    repo: ctx.repo,
    prNumber: ctx.prNumber,
    interactive: {
      commandName: command.name,
      authorId: ctx.authorId,
      authorLogin: ctx.authorLogin,
      body: ctx.body,
      workspace: ctx.workspace,
      commentRef: ctx.commentRef,
      parentRef: ctx.parentRef,
      findingRef: command.findingRef ?? ctx.findingRef,
      sourceCommentRef: ctx.commentRef,
      // WR-01: carry the provider-safe config so the inline consumer never re-derives it via the
      // owner/repo collision path (critical for Bitbucket pause/resume/reject authorization).
      configSnapshot: config,
    },
  };
  if (installationId) {
    message.installationId = installationId;
  }
  await env.REVIEW_QUEUE.send(message);
  return { outcome: 'command_enqueued' };
}
