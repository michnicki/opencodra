import { describe, it, expect, afterEach } from 'vitest';
import { getDb } from '@server/db/client';
import {
  bytesToHex,
  findExistingJobForHead,
  getJobForProcessing,
  insertJob,
  mapJob,
  mostRecentJobForPullRequest,
  supersedeOlderJobs,
  updateJobStatusCheckRef,
} from '@server/db/jobs';
import { recordWebhookDelivery } from '@server/db/webhook-deliveries';
import { defaultRepoConfig, jobSummarySchema } from '@shared/schema';
import type { AppBindings } from '@server/env';
import { createTestEnv, hasConfiguredTestDatabaseUrl } from './helpers';

// Wave 0 jobs/webhook-deliveries provider-aware widening tests (D-02 / REV-C-1 / REV-C-3 /
// REV-C-4 / REV-R-D / REV-R-E / D-04 / R-01). Every behavior the plan pins for the new accessors
// and the byte-identity guarantee for the existing GitHub-only call sites.
const dbDescribe = hasConfiguredTestDatabaseUrl() ? describe : describe.skip;

function sha(char: string): string {
  return char.repeat(40);
}

function uniqueOwner(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

function uniqueRepo(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

dbDescribe('jobs + webhook-deliveries provider filter (D-02 / D-04 / R-01 / REV-C-* / REV-R-D / REV-R-E)', () => {
  const env = createTestEnv();
  const createdRepoIds: number[] = [];
  const createdJobIds: string[] = [];
  const createdWebhookDeliveryIds: string[] = [];

  afterEach(async () => {
    // Cascade cleanup via parent rows. Order matters because of FKs.
    if (createdJobIds.length > 0) {
      await getDb(env).query('DELETE FROM jobs WHERE id = ANY($1::uuid[])', [createdJobIds]);
      createdJobIds.length = 0;
    }
    if (createdWebhookDeliveryIds.length > 0) {
      await getDb(env).query(
        'DELETE FROM webhook_deliveries WHERE delivery_id = ANY($1::text[])',
        [createdWebhookDeliveryIds],
      );
      createdWebhookDeliveryIds.length = 0;
    }
    if (createdRepoIds.length > 0) {
      await getDb(env).query('DELETE FROM repositories WHERE id = ANY($1::int[])', [createdRepoIds]);
      createdRepoIds.length = 0;
    }
  });

  it('D-02 byte-identity: findExistingJobForHead without vcsProvider defaults to github and matches github rows only', async () => {
    const owner = uniqueOwner('owner-jpf-d2');
    const repo = uniqueRepo('repo-jpf-d2');
    const commitSha = sha('a');

    const inserted = await insertJob(env, {
      installationId: '7777',
      owner,
      repo,
      prNumber: 1,
      prTitle: 'D-02 github',
      prAuthor: 'dev',
      commitSha,
      baseSha: sha('c'),
      trigger: 'auto',
      headRef: 'feature',
      baseRef: 'main',
      configSnapshot: defaultRepoConfig,
    });
    createdJobIds.push(inserted.id);

    // No vcsProvider argument -- defaults to 'github', matches the seeded row.
    const foundGithub = await findExistingJobForHead(env, {
      owner,
      repo,
      prNumber: 1,
      commitSha,
      trigger: 'auto',
    });
    expect(foundGithub?.id).toBe(inserted.id);

    // Explicit 'github' argument -- same match.
    const foundExplicitGithub = await findExistingJobForHead(env, {
      owner,
      repo,
      prNumber: 1,
      commitSha,
      trigger: 'auto',
      vcsProvider: 'github',
    });
    expect(foundExplicitGithub?.id).toBe(inserted.id);

    // Explicit 'bitbucket' argument -- never matches a github row, even with the same owner/repo
    // and commitSha. This proves the byte-identity guarantee plus the provider-awareness.
    const foundBitbucket = await findExistingJobForHead(env, {
      owner,
      repo,
      prNumber: 1,
      commitSha,
      trigger: 'auto',
      vcsProvider: 'bitbucket',
    });
    expect(foundBitbucket).toBeNull();
  });

  it('D-02 byte-identity: supersedeOlderJobs without vcsProvider defaults to github and matches github rows only', async () => {
    const owner = uniqueOwner('owner-jpf-sd2');
    const repo = uniqueRepo('repo-jpf-sd2');
    const installationId = '8888';

    // Seed two github jobs for the same (owner, repo, prNumber) with different commitShas. The
    // newer one triggers supersede; the no-arg call must default to 'github'.
    const older = await insertJob(env, {
      installationId,
      owner,
      repo,
      prNumber: 7,
      prTitle: 'older',
      prAuthor: 'dev',
      commitSha: sha('a'),
      baseSha: sha('c'),
      trigger: 'auto',
      headRef: 'feature',
      baseRef: 'main',
      configSnapshot: defaultRepoConfig,
    });
    createdJobIds.push(older.id);

    const newer = await insertJob(env, {
      installationId,
      owner,
      repo,
      prNumber: 7,
      prTitle: 'newer',
      prAuthor: 'dev',
      commitSha: sha('b'),
      baseSha: sha('c'),
      trigger: 'auto',
      headRef: 'feature',
      baseRef: 'main',
      configSnapshot: defaultRepoConfig,
    });
    createdJobIds.push(newer.id);

    // No vcsProvider argument -- must default to 'github' and supersede the older job.
    const supersededCount = await supersedeOlderJobs(env, {
      installationId,
      owner,
      repo,
      prNumber: 7,
      newJobId: newer.id,
    });
    expect(supersededCount).toBe(1);

    const olderAfter = await getJobForProcessing(env, older.id);
    const newerAfter = await getJobForProcessing(env, newer.id);
    expect(olderAfter?.status).toBe('superseded');
    expect(newerAfter?.status).toBe('queued');
  });

  it('REV-C-4 supersede bitbucket branch flips older to superseded and ignores installation_id', async () => {
    const workspace = uniqueOwner('ws-jpf-rc4');
    const owner = workspace; // REV-R-C: owner = workspace_slug
    const repo = uniqueRepo('repo-jpf-rc4');

    // Seed two bitbucket jobs (using SQL directly because insertJob takes installationId).
    const olderId = await insertBitbucketJobDirectly(env, workspace, owner, repo, 9, sha('a'), sha('c'), 'queued');
    const newerId = await insertBitbucketJobDirectly(env, workspace, owner, repo, 9, sha('b'), sha('c'), 'queued');
    createdJobIds.push(olderId, newerId);

    const supersededCount = await supersedeOlderJobs(env, {
      workspace,
      owner,
      repo,
      prNumber: 9,
      newJobId: newerId,
      vcsProvider: 'bitbucket',
      // installationId is intentionally OMITTED for the bitbucket branch.
    });
    expect(supersededCount).toBe(1);

    const olderAfter = await getJobForProcessing(env, olderId);
    const newerAfter = await getJobForProcessing(env, newerId);
    expect(olderAfter?.status).toBe('superseded');
    expect(newerAfter?.status).toBe('queued');
  });

  it('D-04 mostRecentJobForPullRequest returns the most recent job for a Bitbucket PR', async () => {
    const workspace = uniqueOwner('ws-jpf-d4');
    const owner = workspace;
    const repo = uniqueRepo('repo-jpf-d4');

    const olderId = await insertBitbucketJobDirectly(env, workspace, owner, repo, 11, sha('a'), sha('c'), 'queued');
    // Force a created_at gap so DESC ordering is deterministic.
    await new Promise((resolve) => setTimeout(resolve, 25));
    const newerId = await insertBitbucketJobDirectly(env, workspace, owner, repo, 11, sha('b'), sha('c'), 'queued');
    createdJobIds.push(olderId, newerId);

    const mostRecent = await mostRecentJobForPullRequest(env, {
      vcsProvider: 'bitbucket',
      workspace,
      owner,
      repo,
      prNumber: 11,
    });
    expect(mostRecent?.id).toBe(newerId);
    // commit_sha on the most recent should be the second-seeded one.
    expect(bytesToHex(mostRecent!.commit_sha)).toBe(sha('b'));
  });

  it('R-01 + REV-C-3: JobRow/mapJob surfaces repositoryVcsProvider + repositoryWorkspace + nullable installationId', async () => {
    // GitHub row: install a job and check the mapped JobSummary.
    const githubOwner = uniqueOwner('owner-jpf-r1-gh');
    const githubRepo = uniqueRepo('repo-jpf-r1-gh');
    const githubJob = await insertJob(env, {
      installationId: '5555',
      owner: githubOwner,
      repo: githubRepo,
      prNumber: 12,
      prTitle: 'gh',
      prAuthor: 'dev',
      commitSha: sha('a'),
      baseSha: sha('c'),
      trigger: 'auto',
      headRef: 'feature',
      baseRef: 'main',
      configSnapshot: defaultRepoConfig,
    });
    createdJobIds.push(githubJob.id);

    // GitHub rows: repositoryVcsProvider='github', repositoryWorkspace=null, installationId=<id>.
    expect(githubJob.repositoryVcsProvider).toBe('github');
    expect(githubJob.repositoryWorkspace).toBeNull();
    expect(githubJob.installationId).toBe('5555');

    // Bitbucket row: insert directly and check the mapped JobSummary.
    const workspace = uniqueOwner('ws-jpf-r1-bb');
    const bbOwner = workspace;
    const bbRepo = uniqueRepo('repo-jpf-r1-bb');
    const bbJobId = await insertBitbucketJobDirectly(env, workspace, bbOwner, bbRepo, 13, sha('a'), sha('c'), 'queued');
    createdJobIds.push(bbJobId);

    const bbRaw = await getJobForProcessing(env, bbJobId);
    const bbMapped = mapJob(bbRaw!);
    expect(bbMapped.repositoryVcsProvider).toBe('bitbucket');
    expect(bbMapped.repositoryWorkspace).toBe(workspace);
    // REV-C-3: nullable installationId for Bitbucket rows.
    expect(bbMapped.installationId).toBeNull();
  });

  it('REV-R-E: updateJobStatusCheckRef writes the jobs.status_check_ref column directly', async () => {
    const owner = uniqueOwner('owner-jpf-rre');
    const repo = uniqueRepo('repo-jpf-rre');
    const inserted = await insertJob(env, {
      installationId: '6666',
      owner,
      repo,
      prNumber: 14,
      prTitle: 'rre',
      prAuthor: 'dev',
      commitSha: sha('a'),
      baseSha: sha('c'),
      trigger: 'auto',
      headRef: 'feature',
      baseRef: 'main',
      configSnapshot: defaultRepoConfig,
    });
    createdJobIds.push(inserted.id);

    await updateJobStatusCheckRef(env, inserted.id, 'codra-review-uuid');

    const raw = await getJobForProcessing(env, inserted.id);
    const mapped = mapJob(raw!);
    expect(mapped.statusCheckRef).toBe('codra-review-uuid');
  });

  it('REV-C-1: insertJob repositoryId bypass leaves the bitbucket row installation_id NULL', async () => {
    const workspace = uniqueOwner('ws-jpf-rc1');
    const owner = workspace;
    const repo = uniqueRepo('repo-jpf-rc1');

    // Insert a Bitbucket row directly (with installation_id explicitly NULL).
    const [repoRow] = await getDb(env).query<{ id: number }>(
      `INSERT INTO repositories (vcs_provider, owner, repo, workspace, installation_id)
       VALUES ('bitbucket', $1, $2, $3, NULL)
       RETURNING id`,
      [owner, repo, workspace],
    );
    const repoId = repoRow!.id;
    createdRepoIds.push(repoId);

    // insertJob with repositoryId supplied + installationId='' -- the bitbucket branch's
    // installation_id column write must be bypassed entirely, so the row stays NULL.
    const inserted = await insertJob(env, {
      installationId: '',
      owner,
      repo,
      prNumber: 15,
      prTitle: 'rc1',
      prAuthor: 'dev',
      commitSha: sha('a'),
      baseSha: sha('c'),
      trigger: 'auto',
      headRef: 'feature',
      baseRef: 'main',
      configSnapshot: defaultRepoConfig,
      repositoryId: repoId,
      vcsProvider: 'bitbucket',
      workspace,
    });
    createdJobIds.push(inserted.id);

    // The repository row's installation_id is STILL NULL -- the bypass path never touched it.
    const [recheck] = await getDb(env).query<{ installation_id: string | null; vcs_provider: string; workspace: string }>(
      `SELECT installation_id, vcs_provider, workspace FROM repositories WHERE id = $1`,
      [repoId],
    );
    expect(recheck?.installation_id).toBeNull();
    expect(recheck?.vcs_provider).toBe('bitbucket');
    expect(recheck?.workspace).toBe(workspace);
  });

  it('REV-R-D: recordWebhookDelivery repositoryId passthrough attributes to the resolved repo', async () => {
    const workspace = uniqueOwner('ws-jpf-rrd');
    const owner = workspace;
    const repo = uniqueRepo('repo-jpf-rrd');

    // Insert a Bitbucket repository row directly.
    const [repoRow] = await getDb(env).query<{ id: number }>(
      `INSERT INTO repositories (vcs_provider, owner, repo, workspace, installation_id)
       VALUES ('bitbucket', $1, $2, $3, NULL)
       RETURNING id`,
      [owner, repo, workspace],
    );
    const repoId = repoRow!.id;
    createdRepoIds.push(repoId);

    const deliveryId = `delivery-rrd-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    createdWebhookDeliveryIds.push(deliveryId);

    const ok = await recordWebhookDelivery(env, {
      deliveryId,
      eventName: 'pullrequest:updated',
      owner: null,
      repo: null,
      repositoryId: repoId,
      payload: { x: 1 },
    });
    expect(ok).toBe(true);

    // Verify the webhook_deliveries row references our repo id (not NULL, not orphan).
    const [deliveryRow] = await getDb(env).query<{ repository_id: number | null }>(
      `SELECT repository_id FROM webhook_deliveries WHERE delivery_id = $1`,
      [deliveryId],
    );
    expect(deliveryRow?.repository_id).toBe(repoId);
  });

  it('Schema widening: jobSummarySchema accepts repositoryVcsProvider, repositoryWorkspace, statusCheckRef', () => {
    const parsed = jobSummarySchema.parse({
      id: crypto.randomUUID(),
      owner: 'o',
      repo: 'r',
      installationId: '1',
      prNumber: 1,
      prTitle: null,
      prAuthor: null,
      commitSha: sha('a'),
      trigger: 'auto',
      status: 'queued',
      verdict: null,
      fileCount: 0,
      commentCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      errorMessage: null,
      steps: [],
      repositoryVcsProvider: 'bitbucket',
      repositoryWorkspace: 'ws',
      statusCheckRef: 'codra-report-uuid',
    });
    expect(parsed.repositoryVcsProvider).toBe('bitbucket');
    expect(parsed.repositoryWorkspace).toBe('ws');
    expect(parsed.statusCheckRef).toBe('codra-report-uuid');

    // Also verify nullable/optional tolerance: a Bitbucket row with installationId=null + workspace=null parses.
    const parsedBitbucket = jobSummarySchema.parse({
      id: crypto.randomUUID(),
      owner: 'o',
      repo: 'r',
      installationId: null,
      prNumber: 1,
      prTitle: null,
      prAuthor: null,
      commitSha: sha('a'),
      trigger: 'auto',
      status: 'queued',
      verdict: null,
      fileCount: 0,
      commentCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      errorMessage: null,
      steps: [],
      repositoryVcsProvider: 'bitbucket',
      repositoryWorkspace: 'ws',
      statusCheckRef: null,
    });
    expect(parsedBitbucket.installationId).toBeNull();
    expect(parsedBitbucket.statusCheckRef).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Insert a Bitbucket job directly via SQL (bypassing insertJob) so we don't have to widen
 * insertJob's signature any further for the test layer. Returns the new job id.
 */
async function insertBitbucketJobDirectly(
  env: AppBindings,
  workspace: string,
  owner: string,
  repo: string,
  prNumber: number,
  commitShaHex: string,
  baseShaHex: string,
  status: 'queued' | 'running',
): Promise<string> {
  // Resolve a bitbucket repo id (insert if absent). This intentionally uses the canonical
  // (vcs_provider, workspace, repo) UNIQUE key, not the deprecated owner/repo path.
  const [repoRow] = await getDb(env).query<{ id: number }>(
    `INSERT INTO repositories (vcs_provider, owner, repo, workspace, installation_id)
     VALUES ('bitbucket', $1, $2, $3, NULL)
     ON CONFLICT (vcs_provider, workspace, repo) DO UPDATE SET owner = EXCLUDED.owner
     RETURNING id`,
    [owner, repo, workspace],
  );
  const repoId = repoRow!.id;

  const [jobRow] = await getDb(env).query<{ id: string }>(
    `INSERT INTO jobs (
       repository_id, pr_number, pr_title, pr_author,
       commit_sha, base_sha, trigger, status, head_ref, base_ref
     )
     VALUES ($1, $2, 'bb', 'dev', $3, $4, 'auto', $5, 'feature', 'main')
     RETURNING id`,
    [repoId, prNumber, hexToBytesLocal(commitShaHex), hexToBytesLocal(baseShaHex), status],
  );
  return jobRow!.id;
}

function hexToBytesLocal(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}