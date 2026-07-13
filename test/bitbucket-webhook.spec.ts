// Wave 3 / Phase 5: the Bitbucket webhook route spec (`POST /webhook/bitbucket`).
//
// Pins the route surface implemented in `src/server/routes/webhook-bitbucket.ts` per
// D-05 / D-06 / D-16 / D-17 / D-19 / D-20 + REV-M-1 + REV-M-6 + REV-M-7 + REV-R-D. The
// route is the live entry point that closes the Phase-3 deferred item (REVIEW finding 3
// of Phase 3 — `ingestReviewWebhookEvent` was extracted provider-agnostic but never made
// provider-aware for concrete jobs) by threading `provider: 'bitbucket'` through the
// ingest helper so a concrete Bitbucket job is attributed to its own `repositories` row
// instead of being mis-attributed to a GitHub repo.
//
// Like `test/webhook-handling.spec.ts`, this drives `createApp()` end-to-end against the
// real Postgres (`TEST_DATABASE_URL`), signs the raw body with HMAC-SHA256, and asserts
// the 16-step handler flow documented in 05-04-PLAN.md. The ingest helper is mocked at
// the `@server/core/webhook-ingest` boundary so every test can assert the exact input it
// received (D-02 / D-17 / NREG-02).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createApp } from '@server/app';
import { queryRows } from '@server/db/client';
import { encryptSecret } from '@server/core/crypto';
import { signWebhookPayload, createTestEnv, hasConfiguredTestDatabaseUrl } from './helpers';

const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;

// --- 11 behaviors pinned by the plan (Task 1 RED gate) -----------------------------------------

const WEBHOOK_SECRET_PLAINTEXT = 'bitbucket-webhook-shared-secret';

const sha = (char: string) => char.repeat(40);

type BitbucketPullRequest = {
  id: number;
  title: string;
  source: { branch: { name: string }; commit: { hash: string } };
  destination: { branch: { name: string }; commit: { hash: string } };
};

type BitbucketRepository = {
  full_name: string;
  workspace: { slug: string };
  uuid: string;
};

type BitbucketWebhookPayload = {
  repository: BitbucketRepository;
  pullrequest: BitbucketPullRequest;
  actor?: { username: string };
};

function buildPayload(overrides: Partial<BitbucketWebhookPayload> = {}): BitbucketWebhookPayload {
  return {
    repository: {
      full_name: `${overrides.repository?.workspace?.slug ?? 'ws-default'}/bb-repo`,
      workspace: { slug: overrides.repository?.workspace?.slug ?? 'ws-default' },
      uuid: overrides.repository?.uuid ?? '{uuid-default}',
    },
    pullrequest: {
      id: overrides.pullrequest?.id ?? 101,
      title: overrides.pullrequest?.title ?? 'Bitbucket PR',
      source: {
        branch: { name: overrides.pullrequest?.source?.branch?.name ?? 'feature' },
        commit: { hash: overrides.pullrequest?.source?.commit?.hash ?? sha('a') },
      },
      destination: {
        branch: { name: overrides.pullrequest?.destination?.branch?.name ?? 'main' },
        commit: { hash: overrides.pullrequest?.destination?.commit?.hash ?? sha('b') },
      },
    },
    actor: overrides.actor ?? { username: 'bb-dev' },
  };
}

dbDescribe('Bitbucket webhook route (Wave 3 / Phase 5)', () => {
  const env = createTestEnv();
  const app = createApp();

  // Identities are unique per test via Date.now() so the shared TEST_DATABASE_URL
  // never collides across runs. Cleanup arrays collect the row ids + workspace/repo
  // tuples so the afterEach deletes them (the global cleanup in test/setup.ts is
  // disabled — review finding 10).
  const createdRepoIds: number[] = [];
  const createdIdentities: Array<{ workspace: string; repoSlug: string }> = [];

  // Mock ingestReviewWebhookEvent so we can assert the provider threaded through
  // without depending on the downstream queue + ingest pipeline. The mock returns a
  // successful `queued` outcome by default; individual tests override it.
  const ingestSpy = vi.fn();
  vi.mock('@server/core/webhook-ingest', async (importOriginal) => {
    const actual = await importOriginal() as any;
    return {
      ...actual,
      ingestReviewWebhookEvent: (...args: any[]) => {
        ingestSpy(...args);
        return Promise.resolve({ outcome: 'queued', job: { id: 'mock-job-id', status: 'queued' } });
      },
    };
  });

  beforeEach(() => {
    ingestSpy.mockClear();
    (env.REVIEW_QUEUE as any).sent.length = 0;
  });

  afterEach(async () => {
    for (const { workspace, repoSlug } of createdIdentities) {
      await queryRows(
        env,
        'DELETE FROM vcs_credentials WHERE workspace = $1 AND repo_slug = $2',
        [workspace, repoSlug],
      );
    }
    createdIdentities.length = 0;

    if (createdRepoIds.length > 0) {
      // FK constraint order: webhook_deliveries + jobs reference repositories via
      // repository_id; delete them first so the repositories DELETE doesn't violate
      // a foreign key.
      await queryRows(
        env,
        'DELETE FROM webhook_deliveries WHERE repository_id = ANY($1::int[])',
        [createdRepoIds],
      );
      await queryRows(
        env,
        'DELETE FROM jobs WHERE repository_id = ANY($1::int[])',
        [createdRepoIds],
      );
      await queryRows(
        env,
        'DELETE FROM repositories WHERE id = ANY($1::int[])',
        [createdRepoIds],
      );
      createdRepoIds.length = 0;
    }
  });

  // Helper: seed a `(vcs_provider='bitbucket', workspace, repo)` repository row.
  async function seedRepository(workspace: string, repoSlug: string): Promise<number> {
    const [row] = await queryRows<{ id: number }>(
      env,
      `INSERT INTO repositories (vcs_provider, owner, repo, workspace)
       VALUES ('bitbucket', $1, $2, $1)
       RETURNING id`,
      [workspace, repoSlug],
    );
    if (!row) throw new Error('seedRepository: no row returned');
    createdRepoIds.push(row.id);
    return row.id;
  }

  // Helper: seed a vcs_credentials row with an encrypted webhook secret.
  async function seedCredential(workspace: string, repoSlug: string, secretPlaintext = WEBHOOK_SECRET_PLAINTEXT) {
    const encrypted = await encryptSecret(env, secretPlaintext);
    await queryRows(
      env,
      `INSERT INTO vcs_credentials (vcs_provider, workspace, repo_slug, encrypted_webhook_secret, encrypted_access_token, created_at, updated_at)
       VALUES ('bitbucket', $1, $2, $3, 'placeholder-encrypted-token', now(), now())
       ON CONFLICT (vcs_provider, workspace, repo_slug) DO UPDATE
         SET encrypted_webhook_secret = EXCLUDED.encrypted_webhook_secret,
             updated_at = now()`,
      [workspace, repoSlug, encrypted],
    );
    createdIdentities.push({ workspace, repoSlug });
  }

  // Helper: send a POST /webhook/bitbucket with optional header overrides.
  async function postWebhook(body: string, headers: Record<string, string>, signatureOverride?: string) {
    const finalHeaders: Record<string, string> = {
      'content-type': 'application/json',
      ...headers,
    };
    if (signatureOverride !== undefined) {
      finalHeaders['x-hub-signature'] = signatureOverride;
    }
    return app.request(
      'http://codra.test/webhook/bitbucket',
      { method: 'POST', headers: finalHeaders, body },
      env,
    );
  }

  // 1. POST /webhook/bitbucket with a valid pullrequest:created payload + valid per-repo
  //    secret → 200/202 with body `{ ok: true, eventName: 'pullrequest:created', reviewed: true }`.
  //    The ingest helper receives `provider: 'bitbucket'` (D-17).
  it('accepts a signed pullrequest:created payload and calls ingest with provider:bitbucket', async () => {
    const workspace = `ws-bb-c-${Date.now()}`;
    const repoSlug = `repo-bb-c-${Date.now()}`;
    await seedRepository(workspace, repoSlug);
    await seedCredential(workspace, repoSlug);

    const payload = buildPayload({
      repository: { full_name: `${workspace}/${repoSlug}`, workspace: { slug: workspace }, uuid: '{u-1}' },
    });
    const body = JSON.stringify(payload);
    const signature = await signWebhookPayload(WEBHOOK_SECRET_PLAINTEXT, body);

    const response = await postWebhook(body, {
      'x-event-key': 'pullrequest:created',
      'x-request-uuid': 'delivery-created-1',
    }, signature);

    const json = await response.json() as any;
    expect([200, 202]).toContain(response.status);
    expect(json.ok).toBe(true);
    expect(json.eventName).toBe('pullrequest:created');
    expect(json.reviewed).toBe(true);

    expect(ingestSpy).toHaveBeenCalledTimes(1);
    const ingestInput = ingestSpy.mock.calls[0][1];
    expect(ingestInput.provider).toBe('bitbucket');
    expect(ingestInput.deliveryId).toBe('delivery-created-1');
  });

  // 2. pullrequest:updated with a DIFFERENT commit hash than any existing job → ingest called,
  //    eventName echoed.
  it('accepts a signed pullrequest:updated with a new commit hash and calls ingest', async () => {
    const workspace = `ws-bb-u-${Date.now()}`;
    const repoSlug = `repo-bb-u-${Date.now()}`;
    const repositoryId = await seedRepository(workspace, repoSlug);
    await seedCredential(workspace, repoSlug);

    const payload = buildPayload({
      repository: { full_name: `${workspace}/${repoSlug}`, workspace: { slug: workspace }, uuid: '{u-2}' },
      pullrequest: { id: 7, title: 'updated PR', source: { branch: { name: 'feature' }, commit: { hash: sha('c') } }, destination: { branch: { name: 'main' }, commit: { hash: sha('d') } } },
    });
    const body = JSON.stringify(payload);
    const signature = await signWebhookPayload(WEBHOOK_SECRET_PLAINTEXT, body);

    const response = await postWebhook(body, {
      'x-event-key': 'pullrequest:updated',
      'x-request-uuid': 'delivery-updated-new',
    }, signature);

    const json = await response.json() as any;
    expect([200, 202]).toContain(response.status);
    expect(json.ok).toBe(true);
    expect(json.eventName).toBe('pullrequest:updated');
    expect(ingestSpy).toHaveBeenCalledTimes(1);

    // Direct DB assertion: the webhook delivery row must have been attributed to the
    // specific Bitbucket repository row (REV-R-D repositoryId passthrough).
    const [delivery] = await queryRows<{ repository_id: number | null }>(
      env,
      'SELECT repository_id FROM webhook_deliveries WHERE delivery_id = $1',
      ['delivery-updated-new'],
    );
    expect(delivery?.repository_id).toBe(repositoryId);
  });

  // 3. pullrequest:updated where source.commit.hash MATCHES the most-recent job for this
  //    (vcs_provider, workspace, owner, repo, prNumber) → 200 with body
  //    `{ ok: true, ignored: true, reason: 'metadata_only_edit', eventName: 'pullrequest:updated' }`.
  //    The ingest helper is NOT called (D-04 short-circuit).
  it('returns 200 ignored metadata_only_edit when commit hash matches the most recent job (D-04)', async () => {
    const workspace = `ws-bb-m-${Date.now()}`;
    const repoSlug = `repo-bb-m-${Date.now()}`;
    await seedRepository(workspace, repoSlug);
    await seedCredential(workspace, repoSlug);

    // Seed an existing job whose commit_sha matches the incoming pullrequest.source.commit.hash.
    const matchedHash = sha('e');
    await queryRows(
      env,
      `INSERT INTO jobs (repository_id, pr_number, pr_title, pr_author, commit_sha, base_sha, trigger, status, config_snapshot, created_at)
       VALUES ($1, $2, 'previous review', 'old-author', $3::bytea, $4::bytea, 'auto', 'done', '{}'::jsonb, now() - interval '5 minutes')`,
      [createdRepoIds[createdRepoIds.length - 1], 11, matchedHash, sha('f')],
    );

    const payload = buildPayload({
      repository: { full_name: `${workspace}/${repoSlug}`, workspace: { slug: workspace }, uuid: '{u-3}' },
      pullrequest: { id: 11, title: 'updated PR', source: { branch: { name: 'feature' }, commit: { hash: matchedHash } }, destination: { branch: { name: 'main' }, commit: { hash: sha('f') } } },
    });
    const body = JSON.stringify(payload);
    const signature = await signWebhookPayload(WEBHOOK_SECRET_PLAINTEXT, body);

    const response = await postWebhook(body, {
      'x-event-key': 'pullrequest:updated',
      'x-request-uuid': 'delivery-metaedit-1',
    }, signature);

    const json = await response.json() as any;
    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.ignored).toBe(true);
    expect(json.reason).toBe('metadata_only_edit');
    expect(json.eventName).toBe('pullrequest:updated');

    expect(ingestSpy).not.toHaveBeenCalled();
  });

  // 4. D-20: no matching repositories row → 202 ignored repository_not_registered. The
  //    ingest helper is NOT called.
  it('returns 202 ignored repository_not_registered when no repositories row exists (D-20)', async () => {
    const workspace = `ws-bb-x-${Date.now()}`;
    const repoSlug = `repo-bb-x-${Date.now()}`;
    // Seed ONLY the credential (so secret lookup succeeds) but NOT the repository.
    // The D-20 short-circuit fires AFTER the HMAC verify + delivery attribution but
    // BEFORE the ingest call — so the route must not call ingest.
    await seedCredential(workspace, repoSlug);

    const payload = buildPayload({
      repository: { full_name: `${workspace}/${repoSlug}`, workspace: { slug: workspace }, uuid: '{u-4}' },
    });
    const body = JSON.stringify(payload);
    const signature = await signWebhookPayload(WEBHOOK_SECRET_PLAINTEXT, body);

    const response = await postWebhook(body, {
      'x-event-key': 'pullrequest:created',
      'x-request-uuid': 'delivery-noreg-1',
    }, signature);

    const json = await response.json() as any;
    expect(response.status).toBe(202);
    expect(json.ok).toBe(true);
    expect(json.ignored).toBe(true);
    expect(json.reason).toBe('repository_not_registered');
    expect(json.eventName).toBe('pullrequest:created');

    expect(ingestSpy).not.toHaveBeenCalled();
  });

  // 5. Missing X-Hub-Signature header → 401 (D-05 fail-closed).
  it('returns 401 when X-Hub-Signature header is missing (D-05)', async () => {
    const workspace = `ws-bb-s-${Date.now()}`;
    const repoSlug = `repo-bb-s-${Date.now()}`;
    await seedRepository(workspace, repoSlug);
    await seedCredential(workspace, repoSlug);

    const payload = buildPayload({
      repository: { full_name: `${workspace}/${repoSlug}`, workspace: { slug: workspace }, uuid: '{u-5}' },
    });
    const body = JSON.stringify(payload);

    const response = await postWebhook(body, {
      'x-event-key': 'pullrequest:created',
      'x-request-uuid': 'delivery-nosig-1',
    });

    expect(response.status).toBe(401);
    expect(ingestSpy).not.toHaveBeenCalled();
  });

  // 6. Tampered body (byte changed after HMAC compute) → 401 (D-05 fail-closed).
  it('returns 401 when the body byte is tampered after HMAC compute (D-05)', async () => {
    const workspace = `ws-bb-t-${Date.now()}`;
    const repoSlug = `repo-bb-t-${Date.now()}`;
    await seedRepository(workspace, repoSlug);
    await seedCredential(workspace, repoSlug);

    const payload = buildPayload({
      repository: { full_name: `${workspace}/${repoSlug}`, workspace: { slug: workspace }, uuid: '{u-6}' },
    });
    const originalBody = JSON.stringify(payload);
    const signature = await signWebhookPayload(WEBHOOK_SECRET_PLAINTEXT, originalBody);
    const tamperedBody = originalBody + ' ';

    const response = await postWebhook(tamperedBody, {
      'x-event-key': 'pullrequest:created',
      'x-request-uuid': 'delivery-tamper-1',
    }, signature);

    expect(response.status).toBe(401);
    expect(ingestSpy).not.toHaveBeenCalled();
  });

  // 7. vcs_credentials row has stored workspace+repo but encrypted_webhook_secret is null
  //    → 401 fail-closed (D-05: secret absent).
  it('returns 401 when the stored webhook secret is null (D-05 fail-closed on absent secret)', async () => {
    const workspace = `ws-bb-w-${Date.now()}`;
    const repoSlug = `repo-bb-w-${Date.now()}`;
    await seedRepository(workspace, repoSlug);

    // Seed a credential row with the webhook secret explicitly NULL.
    const placeholderToken = await encryptSecret(env, 'placeholder-token');
    await queryRows(
      env,
      `INSERT INTO vcs_credentials (vcs_provider, workspace, repo_slug, encrypted_webhook_secret, encrypted_access_token, created_at, updated_at)
       VALUES ('bitbucket', $1, $2, NULL, $3, now(), now())`,
      [workspace, repoSlug, placeholderToken],
    );
    createdIdentities.push({ workspace, repoSlug });

    const payload = buildPayload({
      repository: { full_name: `${workspace}/${repoSlug}`, workspace: { slug: workspace }, uuid: '{u-7}' },
    });
    const body = JSON.stringify(payload);
    const signature = await signWebhookPayload(WEBHOOK_SECRET_PLAINTEXT, body);

    const response = await postWebhook(body, {
      'x-event-key': 'pullrequest:created',
      'x-request-uuid': 'delivery-nullsecret-1',
    }, signature);

    expect(response.status).toBe(401);
    expect(ingestSpy).not.toHaveBeenCalled();
  });

  // 8. vcs_credentials has NO row at all → 401 fail-closed (D-05: secret unconfigured).
  it('returns 401 when no vcs_credentials row exists for the (workspace, repo) (D-05 fail-closed)', async () => {
    const workspace = `ws-bb-u-${Date.now()}-nocred`;
    const repoSlug = `repo-bb-u-${Date.now()}-nocred`;
    await seedRepository(workspace, repoSlug);
    // NO seedCredential call -- no vcs_credentials row.

    const payload = buildPayload({
      repository: { full_name: `${workspace}/${repoSlug}`, workspace: { slug: workspace }, uuid: '{u-8}' },
    });
    const body = JSON.stringify(payload);
    const signature = await signWebhookPayload(WEBHOOK_SECRET_PLAINTEXT, body);

    const response = await postWebhook(body, {
      'x-event-key': 'pullrequest:created',
      'x-request-uuid': 'delivery-nocred-1',
    }, signature);

    expect(response.status).toBe(401);
    expect(ingestSpy).not.toHaveBeenCalled();
  });

  // 9. Missing X-Event-Key header → 400.
  it('returns 400 when X-Event-Key header is missing', async () => {
    const workspace = `ws-bb-nok-${Date.now()}`;
    const repoSlug = `repo-bb-nok-${Date.now()}`;
    await seedRepository(workspace, repoSlug);
    await seedCredential(workspace, repoSlug);

    const payload = buildPayload({
      repository: { full_name: `${workspace}/${repoSlug}`, workspace: { slug: workspace }, uuid: '{u-9}' },
    });
    const body = JSON.stringify(payload);
    const signature = await signWebhookPayload(WEBHOOK_SECRET_PLAINTEXT, body);

    const response = await postWebhook(body, {
      'x-request-uuid': 'delivery-nokey-1',
    }, signature);

    expect(response.status).toBe(400);
    expect(ingestSpy).not.toHaveBeenCalled();
  });

  // 10. D-19: defensive lower-casing of workspace + repo_slug from the payload so a
  //     payload whose repository.workspace.slug is mixed-case (`ACME-PROD`) AND
  //     vcs_credentials has a stored row with `workspace='acme-prod'` → the route
  //     succeeds (D-19 — mirror Phase 4 storage normalization).
  it('lowercases mixed-case workspace + repo_slug to match the stored credential key (D-19)', async () => {
    const lowercaseWorkspace = `ws-bb-d19-${Date.now()}`;
    const lowercaseRepo = `repo-bb-d19-${Date.now()}`;
    // Store credentials in lowercase — Phase 4 storage normalizes keys.
    await seedCredential(lowercaseWorkspace, lowercaseRepo);
    await seedRepository(lowercaseWorkspace, lowercaseRepo);

    const payload = buildPayload({
      repository: {
        full_name: `${lowercaseWorkspace.toUpperCase()}/${lowercaseRepo.toUpperCase()}`,
        workspace: { slug: lowercaseWorkspace.toUpperCase() },
        uuid: '{u-10}',
      },
    });
    const body = JSON.stringify(payload);
    const signature = await signWebhookPayload(WEBHOOK_SECRET_PLAINTEXT, body);

    const response = await postWebhook(body, {
      'x-event-key': 'pullrequest:created',
      'x-request-uuid': 'delivery-d19-1',
    }, signature);

    const json = await response.json() as any;
    // The route must succeed (HMAC over the lowercased credential key) — D-19 fix.
    expect([200, 202]).toContain(response.status);
    expect(json.ok).toBe(true);
    expect(json.eventName).toBe('pullrequest:created');
    expect(ingestSpy).toHaveBeenCalledTimes(1);
    const ingestInput = ingestSpy.mock.calls[0][1];
    expect(ingestInput.provider).toBe('bitbucket');
  });
});

// Tiny indirection so the afterEach can hoist its dependencies separately. The function-form
// helpers `seedRepository` / `seedCredential` / `postWebhook` are declared above inside the
// dbDescribe callback so they share its describe-scoped state.
