import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '@server/env';
import { jsonError } from '@server/core/http';
import { verifyWebhookSignature } from '@server/core/verify';
import { decryptSecret } from '@server/core/crypto';
import { getVcsCredentialSecrets } from '@server/db/vcs-credentials';
import { findRepositoryByBitbucketIdentity } from '@server/db/repositories';
import { mostRecentJobForPullRequest } from '@server/db/jobs';
import { recordWebhookDelivery } from '@server/db/webhook-deliveries';
import { ingestReviewWebhookEvent } from '@server/core/webhook-ingest';
import { getGlobalConfig } from '@server/core/config';
import { defaultRepoConfig, type RepoConfig } from '@shared/schema';
import { bytesToHex } from '@server/db/jobs';
import { pullRequestWebhookPayloadSchema } from '@shared/bitbucket';

// POST /webhook/bitbucket — the live entry point that closes the Phase-3 deferred item
// (REVIEW finding 3 of Phase 3 — `ingestReviewWebhookEvent` was extracted provider-agnostic
// but never made provider-aware for concrete jobs).
//
// 16-step handler flow (the bit-locked surface documented in 05-04-PLAN.md):
//
//   1.  Capture raw body via c.req.text() BEFORE any JSON.parse (preserve byte-identity
//       for HMAC).
//   2.  Read X-Event-Key; missing -> 400.
//   3.  REV-M-6: parse JUST the identity-bearing projection as a small Zod projection
//       (NOT the full payload schema) to obtain {workspace, repo_slug} for credential
//       lookup. Order: identity-projection parse -> getVcsCredentialSecrets -> decryptSecret
//       -> verifyWebhookSignature -> full payload parse.
//   4.  D-19: lowercase `workspace + repo_slug` defensively to match the stored
//       credential key (Phase 4 storage normalization).
//   5.  getVcsCredentialSecrets; null OR encryptedWebhookSecret null -> 401 (D-05 fail-closed).
//   6.  decryptSecret; on throw -> 401.
//   7.  Read X-Hub-Signature; verifyWebhookSignature -> 401 (D-05 fail-closed).
//   8.  REV-M-1: parse the FULL payload as {eventName: xEventKey, ...JSON.parse(rawBody)}
//       and validate against pullRequestWebhookPayloadSchema.safeParse. eventName was
//       injected from the trusted X-Event-Key header so the discriminated union matches.
//   9.  D-20: findRepositoryByBitbucketIdentity; null -> 202 ignored (short-circuit).
//  10.  D-04: if eventName === 'pullrequest:updated', mostRecentJobForPullRequest; if its
//       commitSha == payload.pullrequest.source.commit.hash -> 200 ignored metadata_only_edit.
//  11.  Read X-Request-UUID (or crypto.randomUUID()) as the deliveryId; log context.
//  12.  REV-R-D: recordWebhookDelivery with repositoryId passthrough so the delivery is
//       attributed to the Bitbucket repository row.
//  13.  Construct an inline `ReviewRequest`-shaped value carrying the Bitbucket identity
//       (repositoryVcsProvider: 'bitbucket', repositoryWorkspace, baseSha from
//       payload.pullrequest.destination.commit.hash with '' fallback).
//  14.  Call ingestReviewWebhookEvent with provider: 'bitbucket'.
//  15.  Pattern-match the result union per D-17:
//         - queued:           200 { ok, eventName, reviewed: true }
//         - duplicate:        202 { ok, eventName, duplicate: true, message: 'queued' }
//         - queued_event:     202 { ok, eventName, queued_event: true }
//  16.  Logger redaction of token/secret keys is the trust boundary (T-04-02 carry-over);
//       the raw body is never logged.
//
// All 401/400 paths fail closed (D-05, D-06). The route makes no api.bitbucket.org calls;
// the actual external calls happen in the worker, not the route.

// Small Zod projection used to extract only the identity-bearing prefix of the raw body.
// Strict-by-default; documented provider fields beyond `{repository.workspace.slug,
// repository.name, pullrequest.id}` are dropped here on purpose — the full payload parse
// at step 8 uses the (now passthrough) pullRequestWebhookPayloadSchema.
const bitbucketIdentityProjectionSchema = z.object({
  repository: z.object({
    name: z.string().min(1),
    workspace: z.object({
      slug: z.string().min(1),
    }),
  }),
  pullrequest: z.object({
    id: z.number().int().positive(),
  }),
});

export async function handleBitbucketWebhook(c: Context<AppEnv>) {
  // Step 1: raw body BEFORE any JSON.parse — HMAC verifies on the exact byte sequence.
  const rawBody = await c.req.text();

  // Step 2: X-Event-Key — without it we don't know which schema variant to validate.
  const xEventKey = c.req.header('x-event-key');
  if (!xEventKey) {
    return jsonError('Missing Bitbucket webhook headers.', 400);
  }

  // Step 3: REV-M-6 — identity-projection parse. This is BEFORE HMAC verify because we
  // need {workspace, repo_slug} to look up the per-repo secret to feed into verify. A parse
  // failure here yields a 400 because the route cannot identify the source repo (and so
  // cannot safely branch on a 'good' secret lookup).
  const identityParse = bitbucketIdentityProjectionSchema.safeParse(safeJsonParse(rawBody));
  if (!identityParse.success) {
    return jsonError('Invalid webhook payload.', 400);
  }
  const projectedWorkspace = identityParse.data.repository.workspace.slug;
  const projectedRepoSlug = identityParse.data.repository.name;

  // Step 4: D-19 — defensive lowercase to match the Phase-4 storage normalization.
  const workspace = projectedWorkspace.toLowerCase();
  const repoSlug = projectedRepoSlug.toLowerCase();

  // Step 5: per-repo secret lookup — null row OR null secret fails closed (D-05).
  const credentials = await getVcsCredentialSecrets(c.env, {
    vcsProvider: 'bitbucket',
    workspace,
    repoSlug,
  });
  if (!credentials?.encryptedWebhookSecret) {
    return jsonError('Webhook secret not configured.', 401);
  }

  // Step 6: decrypt the stored secret. A decryption failure (wrong key, corrupted
  // ciphertext, version mismatch) is a 401 — the HMAC cannot verify and we fail closed.
  let decryptedSecret: string;
  try {
    decryptedSecret = await decryptSecret(c.env, credentials.encryptedWebhookSecret);
  } catch {
    return jsonError('Webhook secret could not be decrypted.', 401);
  }

  // Step 7: HMAC verify on the byte-identical raw body. Missing header or bad signature -> 401.
  const signature = c.req.header('x-hub-signature');
  const verified = await verifyWebhookSignature({
    secret: decryptedSecret,
    signatureHeaderName: 'x-hub-signature',
    signature,
    rawBody,
  });
  if (!verified) {
    return jsonError('Invalid webhook signature.', 401);
  }

  // Step 8: REV-M-1 — full payload parse. The eventName is injected from the TRUSTED
  // header (X-Event-Key was not part of rawBody — it was a separate header); an attacker
  // cannot forge an eventName inside the body because the body's eventName field is
  // ignored (the header value is the source of truth).
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    return jsonError('Invalid webhook JSON payload.', 400);
  }

  const envelope = { eventName: xEventKey, ...(typeof parsedBody === 'object' && parsedBody !== null ? parsedBody : {}) };
  const parsed = pullRequestWebhookPayloadSchema.safeParse(envelope);
  if (!parsed.success) {
    return jsonError('Invalid webhook payload.', 400);
  }

  // Step 9: D-20 — short-circuit when no repositories row matches the (workspace, repo)
  // identity. The HMAC verified, but we don't know which repo to attribute this delivery
  // to — return 202 ignored.
  const repositoryId = await findRepositoryByBitbucketIdentity(c.env, { workspace, repoSlug });
  if (repositoryId === null) {
    return c.json({
      ok: true,
      ignored: true,
      eventName: xEventKey,
      reason: 'repository_not_registered',
    }, 202);
  }

  // Step 10: D-04 — metadata-only-edit dedup. If the most-recent job for this PR carries
  // the same commit hash as the incoming pullrequest.source.commit.hash, treat this event
  // as a UI/PR-edit re-delivery and skip enqueueing. This matches the Bitbucket semantics
  // where `pullrequest:updated` fires on title/body/description edits too.
  const prNumber = parsed.data.pullrequest.id;
  const incomingCommitSha = parsed.data.pullrequest.source.commit.hash;
  if (xEventKey === 'pullrequest:updated') {
    const recent = await mostRecentJobForPullRequest(c.env, {
      vcsProvider: 'bitbucket',
      workspace,
      owner: workspace,
      repo: repoSlug,
      prNumber,
    });
    if (recent) {
      const recentCommitSha = bytesToHex(recent.commit_sha);
      if (recentCommitSha === incomingCommitSha) {
        return c.json({
          ok: true,
          ignored: true,
          eventName: xEventKey,
          reason: 'metadata_only_edit',
        }, 200);
      }
    }
  }

  // Step 11: derive the deliveryId. Use the X-Request-UUID header (Bitbucket includes it)
  // when present; fall back to a random UUID for anonymous deliveries.
  const xRequestUUID = c.req.header('x-request-uuid') ?? crypto.randomUUID();

  // Step 12: REV-R-D — record the webhook delivery attributed to the resolved
  // Bitbucket repository row. owner/repo are null (R-10) so the legacy SELECT-by-owner/
  // repo lookup (which would collide with a same-text GitHub repo) is bypassed; the
  // resolved repositoryId is passed directly.
  const insertedDelivery = await recordWebhookDelivery(c.env, {
    deliveryId: xRequestUUID,
    eventName: xEventKey,
    owner: null,
    repo: null,
    repositoryId,
    payload: parsed.data,
  });
  if (!insertedDelivery) {
    return c.json({
      ok: true,
      duplicate: true,
      eventName: xEventKey,
    }, 202);
  }

  // Step 13: construct the ReviewRequest-shaped value carrying the Bitbucket identity.
  // REV-M-7: baseSha tolerates empty string (the Bitbucket route may receive a missing
  // destination.commit.hash from the parsed projection).
  const reviewRequest = {
    installationId: '',
    owner: workspace,
    repo: repoSlug,
    prNumber,
    prTitle: parsed.data.pullrequest.title,
    prAuthor: (typeof parsedBody === 'object' && parsedBody !== null && 'actor' in parsedBody && typeof (parsedBody as { actor?: unknown }).actor === 'object' && (parsedBody as { actor?: { username?: string } }).actor?.username) || null,
    commitSha: incomingCommitSha,
    baseSha: parsed.data.pullrequest.destination.commit.hash ?? '',
    headRef: parsed.data.pullrequest.source.branch.name,
    baseRef: parsed.data.pullrequest.destination.branch.name,
    trigger: 'auto' as const,
    // Bitbucket identity — Task 3 widening:
    repositoryVcsProvider: 'bitbucket' as const,
    repositoryWorkspace: workspace,
  };

  // Step 13b: resolve the review model strategy. defaultRepoConfig's model section is empty
  // ({ main: null, fallbacks: [], size_overrides: [] }), so snapshotting it verbatim makes
  // ModelService.selectModel throw "No review model strategy is configured" and fail every
  // Bitbucket review before finalize (no comments posted, job 'failed'). Merge the GLOBAL model
  // strategy — the same source loadRepoConfig uses for a repo with no per-repo override
  // (KV key config:global_model, set from the Settings dashboard) — so Bitbucket jobs resolve a
  // model chain exactly like GitHub jobs. We intentionally do NOT call loadRepoConfig here: its
  // syncRepoConfig -> getOrCreateRepository side effect is GitHub-shaped (installationId='' and no
  // vcs_provider/workspace) and would create a spurious vcs_provider='github' row for this
  // Bitbucket repo. (Per-repo Bitbucket model overrides need a provider-aware getter and are out
  // of scope for this fix.)
  const globalModel = await getGlobalConfig(c.env);
  const configSnapshot: RepoConfig = { ...defaultRepoConfig, model: globalModel };

  // Step 14: hand off to the provider-aware ingest helper (05-04 widening closes the
  // Phase-3 deferred item — reviewRequest.repositoryVcsProvider + input.provider both
  // resolve through effectiveProvider = 'bitbucket').
  const result = await ingestReviewWebhookEvent(c.env, {
    reviewRequest,
    configSnapshot,
    deliveryId: xRequestUUID,
    requestId: c.get('requestId'),
    eventName: xEventKey,
    provider: 'bitbucket',
  });

  // Step 15: D-17 response shapes. Each variant is mutually exclusive.
  if (result.outcome === 'queued') {
    return c.json({
      ok: true,
      eventName: xEventKey,
      reviewed: true,
    }, 200);
  }
  if (result.outcome === 'duplicate') {
    return c.json({
      ok: true,
      eventName: xEventKey,
      duplicate: true,
      message: 'queued',
    }, 202);
  }
  // queued_event
  return c.json({
    ok: true,
    eventName: xEventKey,
    queued_event: true,
  }, 202);
}

export function createBitbucketWebhookRouter() {
  const app = new Hono<AppEnv>();
  app.post('/', handleBitbucketWebhook);
  return app;
}

// JSON.parse wrapper that returns `undefined` instead of throwing — the identity parse
// is the first guard and we want to map a parse failure to a 400, not crash the route.
function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}