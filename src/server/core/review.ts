import { logger } from './logger';
import { isSupportedGitHubWebhookEvent, type GitHubWebhookEventName, type GitHubWebhookPayload, type IssueCommentWebhookPayload, type PullRequestWebhookPayload } from '@shared/github';
import { defaultRepoConfig, normalizeModelId, type ParsedReviewComment, type RepoConfig, type ReviewJobMessage } from '@shared/schema';
import type { AppBindings } from '@server/env';
import { getFileReviewsForJobs, recordRetryableFileReviewFailure, upsertFileReview } from '@server/db/file-reviews';
import { getResolvedModelConfig } from '@server/db/model-configs';
import {
  claimJobLease,
  completeJob,
  completePreparationStep,
  failJob,
  findExistingJobForHead,
  getJobForProcessing,
  getOtherRunningJobsCount,
  heartbeatJobLease,
  insertJob,
  mapJob,
  markJobCheckRunCompleted,
  markJobContinuationQueued,
  releaseJobLease,
  supersedeOlderJobs,
  updateJobCheckRun,
  updateJobStep,
} from '@server/db/jobs';
import { filterReviewableFiles, parseUnifiedDiff } from './diff';

import { GitHubService } from '../services/github';
import { GitHubClient } from './github';
import { isRetryableModelError, ModelService } from '../services/model';
import { FormatterService } from '../services/formatter';
import { TokenTracker } from './token-tracker';
import { loadRepoConfig } from './config';
import { getWebhookDelivery } from '@server/db/webhook-deliveries';
import { sendTelemetryEvent } from './telemetry';
import { getReviewSettings } from '@server/db/app-settings';
import { REVIEW_CONCURRENCY_LIMITS } from '@shared/schema';

type PersistedReviewJob = ReturnType<typeof mapJob>;

export type ReviewJobRunResult =
  | { action: 'ack' }
  | { action: 'retry'; delaySeconds: number }
  | { action: 'next_phase'; phase: 'prepare' | 'review' | 'finalize'; delaySeconds: number };

const REVIEW_CHUNK_WALL_CLOCK_MS = 12 * 60 * 1000;
const JOB_LEASE_SECONDS = 15 * 60;
const BUSY_RETRY_SECONDS = 60;
const RETRYABLE_MODEL_FAILURE_RETRY_DELAYS_SECONDS = [60, 5 * 60, 15 * 60];
const MAX_RETRYABLE_FILE_REVIEW_FAILURES = 3;
// A job's commit (and therefore its diff) never changes, so the raw diff can be
// cached for the job's entire lifetime instead of being re-fetched from GitHub on
// every prepare/review-chunk/finalize phase. 6h comfortably covers even a job that
// hits every retryable-failure backoff (up to 15 min each, several times over).
const DIFF_CACHE_TTL_SECONDS = 6 * 60 * 60;
// Conservative worst-case subrequest cost of reviewing one file: up to ~3 models in a
// fallback chain (primary + fallbacks), each costing up to ~3 subrequests (model config
// lookup, an optional provider-availability check, and the provider call itself). Used only
// to size how many files can safely be reviewed concurrently in a chunk given the job's
// remaining subrequest budget for this invocation -- see budgetAwareChunkFileLimit below.
const ESTIMATED_SUBREQUESTS_PER_FILE = 9;

function isRetryableFileReviewErrorMessage(message: string | null | undefined) {
  if (!message) return false;
  const lower = message.toLowerCase();
  return (
    lower.includes('all configured review models failed') ||
    lower.includes('retrying later') ||
    lower.includes('google request failed with 5') ||
    lower.includes('cloudflare') ||
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('internal error') ||
    lower.includes('unavailable') ||
    lower.includes('high demand') ||
    lower.includes('temporary') ||
    lower.includes('[redacted]') ||
    lower.includes('returned no review content') ||
    lower.includes('empty response')
  );
}

function retryableModelFailureDelaySeconds(failureCount: number | null | undefined) {
  if (!failureCount || failureCount < 1) return RETRYABLE_MODEL_FAILURE_RETRY_DELAYS_SECONDS[0];
  const index = Math.min(failureCount - 1, RETRYABLE_MODEL_FAILURE_RETRY_DELAYS_SECONDS.length - 1);
  return RETRYABLE_MODEL_FAILURE_RETRY_DELAYS_SECONDS[index];
}

function getRetryableModelFailureDelaySeconds(error: unknown) {
  const record = error && typeof error === 'object' ? error as { retryAfterSeconds?: unknown } : null;
  const retryAfterSeconds =
    typeof record?.retryAfterSeconds === 'number'
      ? record.retryAfterSeconds
      : null;
  return retryAfterSeconds ?? RETRYABLE_MODEL_FAILURE_RETRY_DELAYS_SECONDS[0];
}

function shouldRetryExistingFileReview(review: { file_status: string; error_msg: string | null }) {
  return review.file_status === 'failed' && isRetryableFileReviewErrorMessage(review.error_msg);
}

function countsAsHandledFileReview(review: { file_status: string; error_msg: string | null }) {
  return !shouldRetryExistingFileReview(review);
}

function configuredModelSet(config: RepoConfig) {
  const models = new Set<string>();
  const addModel = (model: string | null | undefined) => {
    if (model) models.add(normalizeModelId(model));
  };

  addModel(config.model?.main);
  for (const fallback of config.model?.fallbacks ?? []) {
    addModel(fallback);
  }
  for (const tier of config.model?.size_overrides ?? []) {
    addModel(tier.model);
    for (const fallback of tier.fallbacks ?? []) {
      addModel(fallback);
    }
  }

  return models;
}

function canInheritParentFileReview(config: RepoConfig, review: { model_used: string }) {
  return configuredModelSet(config).has(normalizeModelId(review.model_used));
}

async function resolveModelProviderName(env: Pick<AppBindings, 'HYPERDRIVE'>, modelId: string | null | undefined) {
  if (!modelId || modelId === 'unconfigured') return null;

  try {
    const resolved = await getResolvedModelConfig(env, normalizeModelId(modelId));
    return resolved?.providerName ?? null;
  } catch (error) {
    logger.warn(`Failed to resolve provider for model ${modelId}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function shouldTriggerFromPullRequest(action: PullRequestWebhookPayload['action'], config: RepoConfig['review']) {
  return (config.on as string[]).includes(action);
}

export type ReviewRequest = {
  installationId: string;
  owner: string;
  repo: string;
  prNumber: number;
  prTitle: string | null;
  prAuthor: string | null;
  commitSha: string;
  baseSha: string;
  headRef: string | null;
  baseRef: string | null;
  trigger: 'auto' | 'mention';
};

export function extractReviewRequest(input: {
  eventName: GitHubWebhookEventName;
  payload: GitHubWebhookPayload;
  botUsername: string;
  config: RepoConfig;
}): ReviewRequest | null {
  if (input.eventName === 'pull_request') {
    const payload = input.payload as PullRequestWebhookPayload;
    if (input.config.review.ignore_drafts && payload.pull_request.draft) {
      return null;
    }
    if (!shouldTriggerFromPullRequest(payload.action, input.config.review)) {
      return null;
    }

    return {
      installationId: String(payload.installation?.id ?? ''),
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      prNumber: payload.pull_request.number,
      prTitle: payload.pull_request.title,
      prAuthor: payload.pull_request.user.login,
      commitSha: payload.pull_request.head.sha,
      baseSha: payload.pull_request.base.sha,
      headRef: payload.pull_request.head.ref,
      baseRef: payload.pull_request.base.ref,
      trigger: 'auto' as const,
    };
  }

  if (input.eventName === 'issue_comment') {
    const payload = input.payload as IssueCommentWebhookPayload;
    const mentionTrigger = input.config.review.mention_trigger;

    if (!payload.issue?.pull_request || payload.action !== 'created' || !mentionTrigger) {
      return null;
    }

    if (!payload.comment?.body?.includes(mentionTrigger)) {
      return null;
    }

    return {
      installationId: String(payload.installation?.id ?? ''),
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      prNumber: payload.issue.number,
      prTitle: null,
      prAuthor: null,
      commitSha: '',
      baseSha: '',
      headRef: null,
      baseRef: null,
      trigger: 'mention' as const,
    };
  }

  return null;
}

export async function runReviewJob(env: AppBindings, message: ReviewJobMessage): Promise<ReviewJobRunResult> {
  const resolved = await resolveQueuedJob(env, message);
  if (!resolved) {
    return { action: 'ack' };
  }

  const { concurrencyLevel } = await getReviewSettings(env);
  const maxConcurrentJobs = REVIEW_CONCURRENCY_LIMITS[concurrencyLevel];
  const runningCount = await getOtherRunningJobsCount(env, resolved.job.id);
  if (runningCount >= maxConcurrentJobs) {
    logger.info(`Throttling job ${resolved.job.id}: ${runningCount} other jobs are currently running.`);
    return { action: 'retry', delaySeconds: 30 };
  }

  const leaseOwner = crypto.randomUUID();
  const claim = await claimJobLease(env, resolved.job.id, leaseOwner, JOB_LEASE_SECONDS);
  if (claim.status === 'missing') {
    logger.warn(`Job not found for processing: ${resolved.job.id}`);
    return { action: 'ack' };
  }
  if (claim.status === 'terminal') {
    logger.info(`Job ${resolved.job.id} is already terminal (${claim.row.status}), acking queue delivery.`);
    return { action: 'ack' };
  }
  if (claim.status === 'busy') {
    logger.info(`Job ${resolved.job.id} has a fresh lease; retrying queue delivery later.`);
    return { action: 'retry', delaySeconds: Math.min(BUSY_RETRY_SECONDS, claim.retryAfterSeconds) };
  }

  const job = mapJob(claim.row);
  const phase = resolved.phase;
  const tracker = new TokenTracker();
  const github = new GitHubService(env, job.installationId, tracker);
  const model = new ModelService(env, tracker, { jobId: job.id });
  const formatter = new FormatterService(env.APP_URL);

  try {
    if (phase === 'prepare') {
      await runPreparePhase(env, job, leaseOwner, github);
    } else if (phase === 'finalize') {
      await runFinalizePhase(env, job, leaseOwner, github, formatter);
    } else {
      await runReviewPhase(env, job, leaseOwner, github, model, tracker);
    }

    await releaseJobLease(env, job.id, leaseOwner);
    return { action: 'ack' };
  } catch (error) {
    const messageText = error instanceof Error ? error.message : 'Unknown review failure';
    if (messageText === 'JOB_SUPERSEDED') {
      logger.info(`Job ${job.id} was superseded during execution, stopping.`);
      await releaseJobLease(env, job.id, leaseOwner);
      return { action: 'ack' };
    }

    if (error instanceof NextPhaseError) {
      await releaseJobLease(env, job.id, leaseOwner);
      return { action: 'next_phase', phase: error.phase, delaySeconds: error.delaySeconds };
    }

    if (isRetryableModelError(error)) {
      const delaySeconds = getRetryableModelFailureDelaySeconds(error);
      logger.warn(`Review job hit transient model/provider failure; scheduling delayed continuation: ${job.owner}/${job.repo} PR #${job.prNumber}`, {
        error: messageText,
        phase,
        delaySeconds,
      });
      await markJobContinuationQueued(env, job.id, delaySeconds);
      await releaseJobLease(env, job.id, leaseOwner);
      return { action: 'next_phase', phase, delaySeconds }; // Retry same phase
    }

    logger.error(`Review job failed: ${job.owner}/${job.repo} PR #${job.prNumber}`, error);
    await failJobAndCheckRun(env, job, github, messageText);
    await releaseJobLease(env, job.id, leaseOwner);
    return { action: 'ack' };
  }
}

async function resolveQueuedJob(
  env: AppBindings,
  message: ReviewJobMessage,
): Promise<{ job: PersistedReviewJob; phase: 'prepare' | 'review' | 'finalize' } | null> {
  if (message.jobId) {
    const row = await getJobForProcessing(env, message.jobId);
    return row ? { job: mapJob(row), phase: message.phase ?? 'review' } : null;
  }

  if (!message.eventName) {
    logger.warn('Queue message ignored: missing eventName');
    return null;
  }

  let eventName = message.eventName;
  let payload = message.payload as GitHubWebhookPayload | undefined;

  if (payload === undefined) {
    const delivery = await getWebhookDelivery(env, message.deliveryId);
    if (!delivery) {
      logger.warn(`Queue message ignored: webhook delivery not found: ${message.deliveryId}`);
      return null;
    }

    eventName = delivery.event_name;
    payload = delivery.payload as GitHubWebhookPayload;
  }

  if (!isSupportedGitHubWebhookEvent(eventName)) {
    logger.info(`Queue message ignored: unsupported GitHub event ${eventName}`);
    return null;
  }

  const installationId = String(payload.installation?.id ?? '');
  if (!installationId || !('repository' in payload) || !payload.repository) {
    logger.info('Queue message ignored: missing installation or repository info');
    return null;
  }

  const repoConfig = await loadRepoConfig(env, {
    installationId,
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
  });

  if (repoConfig.enabled === false) {
    logger.info(`Job ignored: repository ${payload.repository.owner.login}/${payload.repository.name} is disabled`);
    return null;
  }

  const extracted = extractReviewRequest({
    eventName,
    payload,
    botUsername: env.BOT_USERNAME,
    config: repoConfig.parsedJson,
  });

  if (!extracted) {
    if (eventName === 'pull_request') {
      const prPayload = payload as PullRequestWebhookPayload;
      if (prPayload.action === 'closed' && repoConfig.parsedJson.review.labels !== false) {
        const labels = repoConfig.parsedJson.review.labels;
        const gh = new GitHubClient(env, installationId);
        await gh.removeIssueLabelsIfPresent(
          prPayload.repository.owner.login,
          prPayload.repository.name,
          prPayload.pull_request.number,
          [labels.p1, labels.p2, labels.p3],
        );
      }
    }
    return null;
  }

  let resolved = extracted;
  const githubClient = new GitHubClient(env, installationId);
  if (eventName === 'issue_comment') {
    const pr = await githubClient.getPullRequest(extracted.owner, extracted.repo, extracted.prNumber);
    resolved = {
      ...extracted,
      prTitle: pr.title,
      prAuthor: pr.user.login,
      commitSha: pr.head.sha,
      baseSha: pr.base.sha,
      headRef: pr.head.ref,
      baseRef: pr.base.ref,
    };
  }

  const duplicateJob = await findExistingJobForHead(env, {
    owner: resolved.owner,
    repo: resolved.repo,
    prNumber: resolved.prNumber,
    commitSha: resolved.commitSha,
    trigger: resolved.trigger,
  });
  if (duplicateJob) {
    if (duplicateJob.status === 'queued' || duplicateJob.status === 'running') {
      logger.info(`Resuming duplicate in-flight job ${duplicateJob.id} for ${resolved.owner}/${resolved.repo} PR #${resolved.prNumber}.`);
      return { job: duplicateJob, phase: message.phase ?? 'prepare' };
    }

    logger.info(`Duplicate terminal job found for ${resolved.owner}/${resolved.repo} PR #${resolved.prNumber}, skipping.`);
    return null;
  }

  const job = await insertJob(env, {
    installationId: resolved.installationId,
    owner: resolved.owner,
    repo: resolved.repo,
    prNumber: resolved.prNumber,
    prTitle: resolved.prTitle,
    prAuthor: resolved.prAuthor,
    commitSha: resolved.commitSha,
    baseSha: resolved.baseSha,
    trigger: resolved.trigger,
    headRef: resolved.headRef,
    baseRef: resolved.baseRef,
    configSnapshot: repoConfig.parsedJson,
  });

  await supersedeOlderJobs(env, {
    installationId: resolved.installationId,
    owner: resolved.owner,
    repo: resolved.repo,
    prNumber: resolved.prNumber,
    newJobId: job.id,
  });

  return { job, phase: 'prepare' };
}

async function runPreparePhase(
  env: AppBindings,
  job: PersistedReviewJob,
  leaseOwner: string,
  github: GitHubService,
) {
  await updateJobStep(env, job.id, 'Preparation', { status: 'running' });
  const pr = await github.getPullRequest(job.owner, job.repo, job.prNumber);
  const config = (job.configSnapshot ?? defaultRepoConfig) as RepoConfig;

  let checkRunId = job.checkRunId;
  if (!checkRunId) {
    const checkRun = await github.createCheckRun(job.owner, job.repo, {
      headSha: pr.head.sha,
      title: 'Review queued',
      summary: 'Codra has started reviewing this pull request.',
    });
    checkRunId = checkRun.id;
    await updateJobCheckRun(env, job.id, checkRun.id);
  }

  const files = await getDiffFiles(env, job, github, config);
  await completePreparationStep(env, job.id, files.length);
  await heartbeatJobLease(env, job.id, leaseOwner, JOB_LEASE_SECONDS);

  if (files.length === 0) {
    await updateJobStep(env, job.id, 'Reviewing Files', { status: 'done' });
    await enqueueJobPhase(env, job.id, 'finalize');
    return;
  }

  if (checkRunId) {
    await github.updateCheckRun(job.owner, job.repo, checkRunId, {
      title: `Reviewing (0/${files.length})`,
      summary: 'Codra is analyzing changed files.',
    });
  }
  await enqueueJobPhase(env, job.id, 'review');
}

async function runReviewPhase(
  env: AppBindings,
  job: PersistedReviewJob,
  leaseOwner: string,
  github: GitHubService,
  model: ModelService,
  tracker: TokenTracker,
) {
  if (!hasCompletedStep(job, 'Preparation')) {
    await runPreparePhase(env, job, leaseOwner, github);
    return;
  }

  await updateJobStep(env, job.id, 'Reviewing Files', { status: 'running' });

  const pr = await github.getPullRequest(job.owner, job.repo, job.prNumber);
  const config = (job.configSnapshot ?? defaultRepoConfig) as RepoConfig;
  const failureModelId = config.model?.main ?? 'unconfigured';
  let failureModelProviderPromise: Promise<string | null> | null = null;
  const resolveFailureModelProvider = () => {
    failureModelProviderPromise ??= resolveModelProviderName(env, failureModelId);
    return failureModelProviderPromise;
  };
  const files = await getDiffFiles(env, job, github, config);
  const totalLineCount = files.reduce((sum, file) => sum + file.lineCount, 0);
  const { concurrencyLevel } = await getReviewSettings(env);
  const configuredChunkFileLimit = REVIEW_CONCURRENCY_LIMITS[concurrencyLevel];
  // Cap this chunk's concurrency by the shared job's remaining subrequest budget, so a run
  // of model/provider failures earlier in this invocation can't push it over Cloudflare's
  // per-invocation subrequest cap (Workers Free plan: 50). While the budget is healthy this
  // is a no-op and the chunk still runs at the fully configured concurrency for speed; it
  // only throttles down (to as little as 1 file at a time) once failures have actually eaten
  // into the budget, and any files it can't get to this chunk simply roll into the next one.
  const budgetAwareChunkFileLimit = Math.max(1, Math.floor(tracker.remainingSafeBudget() / ESTIMATED_SUBREQUESTS_PER_FILE));
  const reviewChunkFileLimit = Math.min(configuredChunkFileLimit, budgetAwareChunkFileLimit);
  const startedAt = Date.now();
  let processedThisChunk = 0;

  const jobIdsToQuery = [job.id];
  if (job.retryOfJobId) jobIdsToQuery.push(job.retryOfJobId);
  const allExistingReviews = await getFileReviewsForJobs(env, jobIdsToQuery);
  const currentReviews = new Map(allExistingReviews.filter((review) => review.job_id === job.id).map((review) => [review.file_path, review]));
  const parentReviews = new Map(allExistingReviews.filter((review) => review.job_id !== job.id && review.file_status === 'done').map((review) => [review.file_path, review]));

  const reviewTasks: Array<Promise<void>> = [];

  for (const file of files) {
    const existingReview = currentReviews.get(file.path);
    if (existingReview && countsAsHandledFileReview(existingReview)) {
      continue;
    }

    const inherited = parentReviews.get(file.path);
    const reviewTask = async () => {
      if (!inherited) {
        await reviewAndPersistFile(env, job, file, pr, config, totalLineCount, model, resolveFailureModelProvider, existingReview);
        return;
      }

      if (!canInheritParentFileReview(config, inherited)) {
        logger.info(`Ignoring inherited review for ${file.path}; parent model ${inherited.model_used} is not in the current model strategy`);
        await reviewAndPersistFile(env, job, file, pr, config, totalLineCount, model, resolveFailureModelProvider, existingReview);
      } else {
        await upsertFileReview(env, job.id, {
          filePath: file.path,
          fileStatus: 'done',
          modelUsed: inherited.model_used,
          modelProvider: inherited.model_provider,
          diffLineCount: inherited.diff_line_count,
          diffInput: inherited.diff_input,
          rawAiOutput: inherited.raw_ai_output,
          parsedComments: inherited.parsed_comments as ParsedReviewComment[],
          inputTokens: inherited.input_tokens,
          outputTokens: inherited.output_tokens,
          durationMs: inherited.duration_ms,
          verdict: inherited.verdict,
          fileSummary: inherited.file_summary,
          overallCorrectness: inherited.overall_correctness,
          confidenceScore: inherited.confidence_score,
          errorMessage: null,
        });
        currentReviews.set(file.path, inherited);
      }
    };

    reviewTasks.push(reviewTask());
    processedThisChunk += 1;

    if (processedThisChunk >= reviewChunkFileLimit || Date.now() - startedAt >= REVIEW_CHUNK_WALL_CLOCK_MS) {
      break;
    }
  }

  const results = await Promise.allSettled(reviewTasks);
  await heartbeatAndCheckSuperseded(env, job.id, leaseOwner);

  const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (rejected.length > 0) {
    rejected.forEach((result, index) => {
      logger.error(`Review chunk task ${index + 1}/${rejected.length} failed`, result.reason);
    });
    
    // If any of the rejected tasks were transient model errors, we must throw a RetryableModelError
    // so that the job orchestrator retries the chunk, instead of failing the job with an AggregateError.
    const retryableError = rejected.map(r => r.reason).find(isRetryableModelError);
    if (retryableError) {
      throw retryableError;
    }

    throw rejected.length === 1
      ? rejected[0].reason
      : new AggregateError(rejected.map((result) => result.reason), `${rejected.length} review chunk tasks failed`);
  }

  const latestReviews = await getFileReviewsForJobs(env, [job.id]);
  const reviewedPaths = new Set(latestReviews.filter(countsAsHandledFileReview).map((review) => review.file_path));
  const completedCount = files.filter((file) => reviewedPaths.has(file.path)).length;

  if (completedCount >= files.length) {
    await updateJobStep(env, job.id, 'Reviewing Files', { status: 'done' });
    await enqueueJobPhase(env, job.id, 'finalize');
    return;
  }

  if (job.checkRunId) {
    await github.updateCheckRun(job.owner, job.repo, job.checkRunId, {
      title: `Reviewing (${completedCount}/${files.length})`,
      summary: 'Codra is continuing this review in the next queue chunk.',
    });
  }
  await enqueueJobPhase(env, job.id, 'review');
}

async function reviewAndPersistFile(
  env: AppBindings,
  job: PersistedReviewJob,
  file: ReturnType<typeof parseUnifiedDiff>[number],
  pr: Awaited<ReturnType<GitHubService['getPullRequest']>>,
  config: RepoConfig,
  totalLineCount: number,
  model: ModelService,
  resolveFailureModelProvider: () => Promise<string | null>,
  previousReview?: { transient_error_count: number },
) {
  const startedAt = Date.now();
  const compactPrompt = (previousReview?.transient_error_count ?? 0) > 0;
  try {
    const response = await model.reviewFile({
      file,
      prTitle: pr.title ?? null,
      prDescription: pr.body ?? null,
      config,
      totalLineCount,
      compactPrompt,
    });

    await upsertFileReview(env, job.id, {
      filePath: file.path,
      fileStatus: 'done',
      modelUsed: response.modelUsed,
      modelProvider: response.provider,
      diffLineCount: file.lineCount,
      diffInput: response.userPrompt,
      rawAiOutput: response.rawText,
      parsedComments: response.parsed.comments,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      durationMs: Date.now() - startedAt,
      verdict: response.parsed.verdict,
      fileSummary: response.parsed.fileSummary,
      overallCorrectness: response.parsed.overallCorrectness,
      confidenceScore: response.parsed.confidenceScore,
      errorMessage: null,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown file review error';
    const modelId = config.model?.main ?? 'unconfigured';
    const modelProvider = await resolveFailureModelProvider();

    if (isRetryableModelError(error)) {
      const failureCount = await recordRetryableFileReviewFailure(env, job.id, {
        filePath: file.path,
        modelUsed: modelId,
        modelProvider,
        diffLineCount: file.lineCount,
        diffInput: '',
        durationMs: Date.now() - startedAt,
        errorMessage,
      });

      if (failureCount >= MAX_RETRYABLE_FILE_REVIEW_FAILURES) {
        const finalError = `Review skipped after ${failureCount} repeated model provider outages.`;
        await upsertFileReview(env, job.id, {
          filePath: file.path,
          fileStatus: 'failed',
          modelUsed: modelId,
          modelProvider,
          diffLineCount: file.lineCount,
          diffInput: '',
          rawAiOutput: null,
          parsedComments: [],
          inputTokens: null,
          outputTokens: null,
          durationMs: Date.now() - startedAt,
          verdict: null,
          fileSummary: null,
          errorMessage: finalError,
        });
        logger.error(`File review failed permanently for ${file.path} after transient retries`, {
          attempts: failureCount,
          error: errorMessage,
        });
        return;
      }

      logger.warn(`File review deferred for ${file.path}; transient model/provider failure will retry later`, {
        error: errorMessage,
        attempts: failureCount,
      });
      Object.defineProperty(error, 'retryAfterSeconds', {
        value: retryableModelFailureDelaySeconds(failureCount),
        configurable: true,
      });
      throw error;
    }

    logger.error(`File review failed for ${file.path}`, { error });

    const isHardLimit =
      errorMessage.toLowerCase().includes('subrequest') ||
      errorMessage.includes('4006') ||
      errorMessage.toLowerCase().includes('allocation');

    if (isHardLimit) {
      logger.warn(`File review hit hard limit for ${file.path}, marking as failed to allow partial PR review.`, { error: errorMessage });
      // We don't throw here; we just fall through and let it be marked as failed
      // so the PR review can continue and complete as a partial review.
    }

    await upsertFileReview(env, job.id, {
      filePath: file.path,
      fileStatus: 'failed',
      modelUsed: modelId,
      modelProvider,
      diffLineCount: file.lineCount,
      diffInput: '',
      rawAiOutput: null,
      parsedComments: [],
      inputTokens: null,
      outputTokens: null,
      durationMs: Date.now() - startedAt,
      verdict: null,
      fileSummary: null,
      errorMessage,
    });
  }
}

async function runFinalizePhase(
  env: AppBindings,
  job: PersistedReviewJob,
  leaseOwner: string,
  github: GitHubService,
  formatter: FormatterService,
) {
  await updateJobStep(env, job.id, 'Generating Summary', { status: 'running' });

  const pr = await github.getPullRequest(job.owner, job.repo, job.prNumber);
  const config = (job.configSnapshot ?? defaultRepoConfig) as RepoConfig;
  const files = await getDiffFiles(env, job, github, config);
  const reviews = await getFileReviewsForJobs(env, [job.id]);

  if (reviews.length < files.length) {
    await updateJobStep(env, job.id, 'Reviewing Files', { status: 'running' });
    await enqueueJobPhase(env, job.id, 'review');
    return;
  }

  const reviewedComments = reviews.flatMap((review) => review.parsed_comments as ParsedReviewComment[]);
  const fileSummaries = reviews.map((review) => ({
    path: review.file_path,
    summary: review.file_status === 'failed'
      ? `Review failed: ${review.error_msg ?? 'Unknown file review error'}`
      : (review.file_summary ?? ''),
    verdict: review.file_status === 'failed' ? 'failed' : (review.verdict ?? 'comment'),
  }));

  if (fileSummaries.length > 0 && fileSummaries.every((file) => file.verdict === 'failed')) {
    await updateJobStep(env, job.id, 'Generating Summary', { status: 'failed', error: 'All files failed to review' });
    
    // Send anonymous telemetry for the failed job
    const fileInputTokens = reviews.reduce((sum, review) => sum + (review.input_tokens ?? 0), 0);
    const fileOutputTokens = reviews.reduce((sum, review) => sum + (review.output_tokens ?? 0), 0);
    const modelsUsed = Array.from(new Set(reviews.map(r => r.model_used).filter(Boolean)));
    const fileExtensions = Array.from(new Set(files.map(f => {
      const parts = f.path.split('.');
      return parts.length > 1 ? parts.pop() || '' : '';
    }).filter(Boolean)));
    const reviewDurationMs = Math.max(0, Date.now() - new Date(job.createdAt).getTime());
    
    try {
      await sendTelemetryEvent(env, {
        linesReviewed: files.reduce((sum, file) => sum + file.lineCount, 0),
        findingsReported: 0,
        inputTokens: fileInputTokens,
        outputTokens: fileOutputTokens,
        modelsUsed,
        fileExtensions,
        triggerType: job.trigger,
        reviewDurationMs,
        filesReviewed: files.length,
        verdict: 'failed',
        severityDistribution: {},
      });
    } catch (e) {
      logger.error('Failed to send telemetry', e instanceof Error ? e : new Error(String(e)));
    }

    throw new Error('All files failed to review');
  }

  const hasFailures = fileSummaries.some((file) => file.verdict === 'failed');
  const failedFileCount = fileSummaries.filter((file) => file.verdict === 'failed').length;
  const severityRanks: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3, nit: 4 };
  const minRank = severityRanks[config.review.min_severity] ?? 4;
  const { maxComments: globalMaxComments } = await getReviewSettings(env);
  const effectiveMaxComments = Math.min(config.review.max_comments, globalMaxComments);

  let finalComments = reviewedComments.filter(c => (severityRanks[c.severity] ?? 4) <= minRank);
  finalComments.sort((a, b) => (severityRanks[a.severity] ?? 4) - (severityRanks[b.severity] ?? 4));

  const omittedCount = reviewedComments.length - Math.min(finalComments.length, effectiveMaxComments);
  if (finalComments.length > effectiveMaxComments) {
    finalComments = finalComments.slice(0, effectiveMaxComments);
  }

  const verdictSummary = formatter.summarizeVerdict(finalComments, hasFailures);
  await updateJobStep(env, job.id, 'Generating Summary', { status: 'done' });
  await heartbeatAndCheckSuperseded(env, job.id, leaseOwner);

  let formattedSummary = formatter.formatReviewOverview(pr.head.sha, env.BOT_USERNAME);

  if (omittedCount > 0) {
    formattedSummary += `\n\n> [!NOTE]\n> **${omittedCount} comments were omitted** from this review to reduce noise and respect the configured \`max_comments\` limit (${effectiveMaxComments}). Showing the most critical issues.`;
  }

  await updateJobStep(env, job.id, 'Completing', { status: 'running' });
  const review = await github.createReview(job.owner, job.repo, job.prNumber, {
    commitSha: pr.head.sha,
    event: formatter.toReviewEvent(verdictSummary.verdict),
    body: formattedSummary,
    comments: finalComments.map(comment => ({
      path: comment.path,
      position: comment.position ?? undefined,
      body: formatter.formatInlineComment(comment),
    })),
  });

  if (config.review.labels !== false) {
    const labels = config.review.labels;
    const labelMap = {
      comment: { name: labels.p1, color: 'f79009' },
      approve: { name: labels.p2, color: '027a48' },
    } as const;
    const label = labelMap[verdictSummary.verdict];

    await github.removeIssueLabelsIfPresent(
      job.owner,
      job.repo,
      job.prNumber,
      [labels.p1, labels.p2, labels.p3].filter(possibleLabel => possibleLabel !== label.name),
    );

    await github.ensureLabel(job.owner, job.repo, label.name, label.color);
    await github.addIssueLabels(job.owner, job.repo, job.prNumber, [label.name]);
  }

  if (job.checkRunId) {
    await github.updateCheckRun(job.owner, job.repo, job.checkRunId, {
      status: 'completed',
      conclusion: hasFailures ? 'failure' : (verdictSummary.verdict === 'approve' ? 'success' : 'neutral'),
      title: hasFailures ? 'Review partially failed' : (verdictSummary.verdict === 'approve' ? 'LGTM' : 'Comments posted'),
      summary: `${finalComments.length} inline comments across ${files.length} files.${hasFailures ? ` ${failedFileCount} file${failedFileCount === 1 ? '' : 's'} could not be reviewed after repeated provider outages.` : ''}`,
    });
  }

  const fileInputTokens = reviews.reduce((sum, review) => sum + (review.input_tokens ?? 0), 0);
  const fileOutputTokens = reviews.reduce((sum, review) => sum + (review.output_tokens ?? 0), 0);
  
  const modelsUsed = Array.from(new Set(reviews.map(r => r.model_used).filter(Boolean)));
  const fileExtensions = Array.from(new Set(files.map(f => {
    const parts = f.path.split('.');
    return parts.length > 1 ? parts.pop() || '' : '';
  }).filter(Boolean)));
  const reviewDurationMs = Math.max(0, Date.now() - new Date(job.createdAt).getTime());

  const severityDistribution: Record<string, number> = {};
  for (const comment of finalComments) {
    const sev = comment.severity || 'unknown';
    severityDistribution[sev] = (severityDistribution[sev] || 0) + 1;
  }

  const partialErrorMessage = hasFailures
    ? `Partial review: ${failedFileCount} of ${files.length} file${files.length === 1 ? '' : 's'} could not be reviewed after repeated model/provider outages.`
    : null;
  await completeJob(env, job.id, {
    verdict: verdictSummary.verdict,
    fileCount: files.length,
    commentCount: finalComments.length,
    totalInputTokens: fileInputTokens,
    totalOutputTokens: fileOutputTokens,
    summaryMarkdown: formattedSummary,
    reviewId: review.id,
    summaryModel: null,
    errorMessage: partialErrorMessage,
  });
  logger.info(`Review job completed: ${job.owner}/${job.repo} PR #${job.prNumber}`);

  // Send anonymous telemetry
  try {
    await sendTelemetryEvent(env, {
      linesReviewed: files.reduce((sum, file) => sum + file.lineCount, 0),
      findingsReported: finalComments.length,
      inputTokens: fileInputTokens,
      outputTokens: fileOutputTokens,
      modelsUsed,
      fileExtensions,
      triggerType: job.trigger,
      reviewDurationMs,
      filesReviewed: files.length,
      verdict: verdictSummary.verdict,
      severityDistribution,
    });
  } catch (e) {
    logger.error('Failed to send telemetry', e instanceof Error ? e : new Error(String(e)));
  }
}

async function heartbeatAndCheckSuperseded(env: AppBindings, jobId: string, leaseOwner: string) {
  await heartbeatJobLease(env, jobId, leaseOwner, JOB_LEASE_SECONDS);
  const currentJob = await getJobForProcessing(env, jobId);
  if (currentJob?.status === 'superseded') {
    throw new Error('JOB_SUPERSEDED');
  }
}

export class NextPhaseError extends Error {
  constructor(public phase: 'prepare' | 'review' | 'finalize', public delaySeconds: number) {
    super(`NextPhase: ${phase}`);
  }
}

async function enqueueJobPhase(
  env: AppBindings,
  jobId: string,
  phase: 'prepare' | 'review' | 'finalize',
  delaySeconds = 0,
) {
  await markJobContinuationQueued(env, jobId, delaySeconds);
  throw new NextPhaseError(phase, delaySeconds);
}

function hasCompletedStep(job: PersistedReviewJob, stepName: string) {
  return job.steps.some((step) => step.name === stepName && step.status === 'done');
}

function diffCacheKey(jobId: string) {
  return `diff:${jobId}`;
}

/**
 * Returns the job's reviewable files, fetching and parsing the PR diff from
 * GitHub only once per job (cached in KV) instead of once per phase invocation.
 */
export async function getDiffFiles(
  env: AppBindings,
  job: Pick<PersistedReviewJob, 'id' | 'owner' | 'repo' | 'prNumber'>,
  github: Pick<GitHubService, 'getPullRequestDiff'>,
  config: RepoConfig,
) {
  const cacheKey = diffCacheKey(job.id);
  let rawDiff = await env.APP_KV.get(cacheKey);

  if (!rawDiff) {
    rawDiff = await github.getPullRequestDiff(job.owner, job.repo, job.prNumber);
    try {
      await env.APP_KV.put(cacheKey, rawDiff, { expirationTtl: DIFF_CACHE_TTL_SECONDS });
    } catch (error) {
      logger.warn(`Failed to cache PR diff for job ${job.id}; it will be re-fetched on the next phase`, error instanceof Error ? error : new Error(String(error)));
    }
  }

  return filterReviewableFiles(parseUnifiedDiff(rawDiff, config.review), config.review);
}

export async function failJobAndCheckRun(
  env: AppBindings,
  job: Pick<PersistedReviewJob, 'id' | 'owner' | 'repo' | 'checkRunId'>,
  github: Pick<GitHubService, 'updateCheckRun'>,
  message: string,
) {
  // Marking the job failed in the DB is the critical, must-not-lose write: it's what
  // makes the job terminal so it stops being retried, and it's what makes it eligible
  // for completeTerminalCheckRuns() to pick up later if the GitHub call below fails.
  try {
    await failJob(env, job.id, message);
  } catch (dbError) {
    logger.error(`Critical: failed to mark job ${job.id} as failed in the DB; it may remain stuck until lease-expiry recovery reclaims it`, dbError);
    return;
  }

  // Updating the GitHub check run is best-effort here. If it fails (e.g. the Worker's
  // subrequest budget for this invocation is already exhausted from the review itself),
  // the job is still durably marked failed above, and the opportunistic maintenance sweep
  // (completeTerminalCheckRuns) will retry this update on a later invocation with a fresh budget.
  try {
    const latest = await getJobForProcessing(env, job.id);
    const checkRunId = latest?.check_run_id ?? job.checkRunId;
    if (checkRunId) {
      await github.updateCheckRun(job.owner, job.repo, checkRunId, {
        status: 'completed',
        conclusion: 'failure',
        title: 'Review failed',
        summary: message,
      });
      await markJobCheckRunCompleted(env, job.id);
    }
  } catch (checkRunError) {
    logger.warn(`Failed to update GitHub check run for failed job ${job.id}; opportunistic maintenance will retry it`, checkRunError);
  }
}
