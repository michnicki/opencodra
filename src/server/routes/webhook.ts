import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  isSupportedGitHubWebhookEvent,
  type GitHubWebhookPayload,
  type IssueCommentWebhookPayload,
  type PullRequestReviewCommentWebhookPayload,
  type PullRequestWebhookPayload,
} from '@shared/github';
import type { AppEnv } from '@server/env';
import { loadRepoConfig } from '@server/core/config';
import { extractReviewRequest, type ReviewRequest } from '@server/core/review';
import { verifyGitHubWebhookSignature } from '@server/core/verify';
import { jsonError } from '@server/core/http';
import { ingestReviewWebhookEvent, isTransientCommentError, type WebhookIngestResult } from '@server/core/webhook-ingest';
import type { CommentContext } from '@server/core/commands';
import { recordWebhookDelivery, deleteWebhookDelivery } from '@server/db/webhook-deliveries';
import { logger } from '@server/core/logger';

// A mention-shaped ReviewRequest carrying the installationId the GitHub comment branch in the shared
// seam needs to construct the provider + insert a command review job (the seam reads it via
// input.reviewRequest?.installationId — Bitbucket carries none). SHAs/refs are empty because a comment
// event carries no PR head/base; the seam hydrates them from the live PR when a review command runs.
function buildMentionReviewRequest(input: {
  installationId: string;
  owner: string;
  repo: string;
  prNumber: number;
}): ReviewRequest {
  return {
    installationId: input.installationId,
    owner: input.owner,
    repo: input.repo,
    prNumber: input.prNumber,
    prTitle: null,
    prAuthor: null,
    commitSha: '',
    baseSha: '',
    headRef: null,
    baseRef: null,
    trigger: 'mention',
  };
}

// Project a GitHub comment payload into the provider-agnostic CommentContext. authorId is the
// IMMUTABLE numeric user id (as a string) — the ONLY id the self-filter/authorization key on (NREG-02),
// NEVER the renameable login. `in_reply_to_id` maps to findingRef so a reply left under an inline
// finding dismisses that finding (D-09, parity with Bitbucket comment.parent.id). workspace = owner
// login (the canonical GitHub pause-key workspace).
function buildGithubCommentContext(input: {
  prNumber: number;
  owner: string;
  repo: string;
  comment: { id: number; body: string; user: { id: number; login: string }; in_reply_to_id?: number };
}): CommentContext {
  const inReplyTo = input.comment.in_reply_to_id;
  const findingRef = inReplyTo !== undefined ? String(inReplyTo) : undefined;
  return {
    authorId: String(input.comment.user.id),
    authorLogin: input.comment.user.login,
    body: input.comment.body,
    prNumber: input.prNumber,
    commentRef: String(input.comment.id),
    parentRef: findingRef,
    findingRef,
    owner: input.owner,
    repo: input.repo,
    workspace: input.owner,
  };
}

// Map every ingest outcome to the response shape. The pull_request auto path keeps its pre-Phase-11
// bytes (`queued` -> { ok, message:'queued', job }; `queued_event`/duplicate unchanged, NREG-01); the
// Phase-11 comment outcomes surface as explicit dispatched/ignored responses.
function respondToIngest(c: Context<AppEnv>, result: WebhookIngestResult): Response {
  switch (result.outcome) {
    case 'duplicate':
      return c.json({
        ok: true,
        duplicate: true,
        message: result.job.status === 'queued' ? 'queued' : 'duplicate',
        job: result.job,
      }, 202);
    case 'queued':
      return c.json({ ok: true, message: 'queued', job: result.job }, 202);
    case 'command_enqueued':
      return c.json({ ok: true, message: 'command_enqueued' }, 202);
    case 'qa_enqueued':
      return c.json({ ok: true, message: 'qa_enqueued' }, 202);
    case 'ignored_comment':
      return c.json({ ok: true, ignored: true, reason: result.reason }, 202);
    case 'ignored_paused':
      return c.json({ ok: true, ignored: true, reason: 'paused' }, 202);
    case 'ignored_directive':
      return c.json({ ok: true, ignored: true, reason: 'ignore_directive' }, 202);
    case 'queued_event':
    default:
      return c.json({ ok: true, message: 'queued' }, 202);
  }
}

// WR-03: run a comment-branch ingest so a TRANSIENT failure (bot-identity resolve / PR hydration /
// provider network) does not permanently drop the command. `recordWebhookDelivery` already ran its
// idempotent insert before this point, so a bare throw here returns a 5xx whose retry is short-
// circuited by the duplicate-delivery guard BEFORE classification re-runs. On a transient failure we
// delete the delivery record first, so the provider's retry re-processes cleanly; a deterministic
// failure keeps the record (retrying would not help) and still surfaces as a 5xx.
async function ingestCommentEventOrRetry(
  c: Context<AppEnv>,
  deliveryId: string,
  input: Parameters<typeof ingestReviewWebhookEvent>[1],
): Promise<Response> {
  try {
    const result = await ingestReviewWebhookEvent(c.env, input);
    return respondToIngest(c, result);
  } catch (error) {
    if (isTransientCommentError(error)) {
      try {
        await deleteWebhookDelivery(c.env, deliveryId);
      } catch (deleteError) {
        logger.error(
          'Failed to delete webhook delivery after a transient comment-ingest failure; the retry may be swallowed by the dedup guard',
          deleteError instanceof Error ? deleteError : new Error(String(deleteError)),
        );
      }
    }
    throw error;
  }
}

export async function handleGitHubWebhook(c: Context<AppEnv>) {
    const eventName = c.req.header('x-github-event');
    const deliveryId = c.req.header('x-github-delivery');
    const signature = c.req.header('x-hub-signature-256');
    const rawBody = await c.req.text();

    if (!eventName || !deliveryId) {
      return jsonError('Missing GitHub webhook headers.', 400);
    }

    const verified = await verifyGitHubWebhookSignature(c.env.GITHUB_APP_WEBHOOK_SECRET, signature ?? null, rawBody);
    if (!verified) {
      return jsonError('Invalid webhook signature.', 401);
    }

    let payload: GitHubWebhookPayload;
    try {
      payload = JSON.parse(rawBody) as GitHubWebhookPayload;
    } catch {
      return jsonError('Invalid webhook JSON payload.', 400);
    }

    const insertedDelivery = await recordWebhookDelivery(c.env, {
      deliveryId,
      eventName,
      owner: 'repository' in payload ? payload.repository.owner.login : null,
      repo: 'repository' in payload ? payload.repository.name : null,
      payload,
    });

    if (!insertedDelivery) {
      return c.json({ ok: true, duplicate: true }, 202);
    }

    const installationId = String(payload.installation?.id ?? '');
    if (!installationId || !('repository' in payload) || !payload.repository) {
      return c.json({ ok: true, ignored: true }, 202);
    }

    if (!isSupportedGitHubWebhookEvent(eventName)) {
      return c.json({ ok: true, ignored: true, eventName }, 202);
    }

    const repoConfig = await loadRepoConfig(c.env, {
      installationId,
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
    });

    if (repoConfig.enabled === false) {
      return c.json({ ok: true, ignored: true, reason: 'repository_disabled' }, 202);
    }

    const config = repoConfig.parsedJson;
    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    // The interactive comment surface (commands / Q&A) is only wired when at least one toggle is on.
    // With BOTH off, issue_comment keeps its pre-Phase-11 legacy `@mention` review path (extract ->
    // queued_event -> Workflow) so mention-triggers-review stays byte-identical (NREG-01); we do NOT
    // thread commentContext there.
    const interactiveEnabled =
      config.review.interactive.commands.enabled || config.review.interactive.qa.enabled;

    // ── pull_request_review_comment (D-09, OQ2): a reply left UNDER an inline review finding. This is a
    //    net-new subscription with no legacy path — always project a CommentContext and hand off to the
    //    seam, which self-filters/classifies (feature on) or returns ignored_comment with no job / no
    //    side effect (feature off, NREG-01). in_reply_to_id -> findingRef is the reply-under-finding
    //    reject linkage (parity with Bitbucket comment.parent.id).
    if (eventName === 'pull_request_review_comment') {
      const reviewComment = payload as PullRequestReviewCommentWebhookPayload;
      if (reviewComment.action !== 'created') {
        return c.json({ ok: true, ignored: true, eventName }, 202);
      }
      const prNumber = reviewComment.pull_request.number;
      const commentContext = buildGithubCommentContext({
        prNumber,
        owner,
        repo,
        comment: reviewComment.comment,
      });
      return ingestCommentEventOrRetry(c, deliveryId, {
        reviewRequest: buildMentionReviewRequest({ installationId, owner, repo, prNumber }),
        configSnapshot: config,
        deliveryId,
        requestId: c.get('requestId'),
        eventName,
        commentContext,
      });
    }

    // ── issue_comment WITH interactive on: a PR-level comment. Project a CommentContext and hand off
    //    to the seam (self-filter -> command / qa / ignored). Only PR comments (issue.pull_request
    //    present) with action 'created' are relevant; anything else is ignored.
    if (eventName === 'issue_comment' && interactiveEnabled) {
      const issueComment = payload as IssueCommentWebhookPayload;
      if (!issueComment.issue?.pull_request || issueComment.action !== 'created') {
        return c.json({ ok: true, ignored: true, eventName }, 202);
      }
      const prNumber = issueComment.issue.number;
      const commentContext = buildGithubCommentContext({
        prNumber,
        owner,
        repo,
        comment: issueComment.comment,
      });
      return ingestCommentEventOrRetry(c, deliveryId, {
        reviewRequest: buildMentionReviewRequest({ installationId, owner, repo, prNumber }),
        configSnapshot: config,
        deliveryId,
        requestId: c.get('requestId'),
        eventName,
        commentContext,
      });
    }

    // ── pull_request AUTO path (+ issue_comment legacy mention path when interactive is off). Behavior
    //    is byte-identical to pre-Phase-11 (NREG-01) except the pull_request branch now forwards
    //    prBody = pull_request.body so the commands-gated CMD-06 ignore gate has the PR description on
    //    AUTO events too (REVIEW: Codex 11-06/11-07).
    const extracted = extractReviewRequest({
      eventName,
      payload,
      botUsername: c.env.BOT_USERNAME,
      config,
    });

    const prBody =
      eventName === 'pull_request'
        ? (payload as PullRequestWebhookPayload).pull_request.body ?? undefined
        : undefined;

    const result = await ingestReviewWebhookEvent(c.env, {
      reviewRequest: extracted,
      configSnapshot: config,
      deliveryId,
      requestId: c.get('requestId'),
      eventName,
      prBody,
    });

    return respondToIngest(c, result);
}

export function createWebhookRouter() {
  const app = new Hono<AppEnv>();

  app.post('/', handleGitHubWebhook);

  return app;
}
