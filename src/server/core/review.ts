import { logger } from './logger';
import { isSupportedGitHubWebhookEvent, type GitHubWebhookEventName, type GitHubWebhookPayload, type IssueCommentWebhookPayload, type PullRequestWebhookPayload } from '@shared/github';
import { defaultRepoConfig, type ParsedReviewComment, type RepoConfig, type ReviewJobMessage } from '@shared/schema';
import type { AppBindings } from '@server/env';
import { getFileReviewsForJobs } from '@server/db/file-reviews';
import { completeJob, failJob, findExistingJobForHead, getJobForProcessing, insertJob, mapJob, startJobProcessing, completePreparationStep, supersedeOlderJobs, updateJobCheckRun, updateJobStep } from '@server/db/jobs';
import { filterReviewableFiles, parseUnifiedDiff } from './diff';

import { GitHubService } from '../services/github';
import { GitHubClient } from './github';
import { ModelService } from '../services/model';
import { FormatterService } from '../services/formatter';
import { TokenTracker } from './token-tracker';
import { loadRepoConfig } from './config';
import { getWebhookDelivery } from '@server/db/webhook-deliveries';

type PersistedReviewJob = ReturnType<typeof mapJob>;

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

export async function runReviewJob(env: AppBindings, message: ReviewJobMessage) {
  let job: PersistedReviewJob;

  if (message.jobId) {
    const row = await getJobForProcessing(env, message.jobId);
    if (!row) {
      logger.warn(`Job not found for processing: ${message.jobId}`);
      return;
    }

    job = mapJob(row);
    if (job.status === 'superseded') {
      logger.info(`Job ${job.id} is superseded, skipping processing.`);
      return;
    }
    if (job.status === 'running') {
      logger.info(`Job ${job.id} is already running, skipping duplicate queue delivery.`);
      return;
    }
  } else {
    if (!message.eventName) {
      logger.warn('Queue message ignored: missing eventName');
      return;
    }

    let eventName = message.eventName;
    let payload = message.payload as GitHubWebhookPayload | undefined;

    if (payload === undefined) {
      const delivery = await getWebhookDelivery(env, message.deliveryId);
      if (!delivery) {
        logger.warn(`Queue message ignored: webhook delivery not found: ${message.deliveryId}`);
        return;
      }

      eventName = delivery.event_name;
      payload = delivery.payload as GitHubWebhookPayload;
    }

    if (!isSupportedGitHubWebhookEvent(eventName)) {
      logger.info(`Queue message ignored: unsupported GitHub event ${eventName}`);
      return;
    }

    const installationId = String(payload.installation?.id ?? '');
    if (!installationId || !('repository' in payload) || !payload.repository) {
      logger.info('Queue message ignored: missing installation or repository info');
      return;
    }

    // 1. Load Repo Config
    const repoConfig = await loadRepoConfig(env, {
      installationId,
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
    });

    if (repoConfig.enabled === false) {
      logger.info(`Job ignored: repository ${payload.repository.owner.login}/${payload.repository.name} is disabled`);
      return;
    }

    // 2. Extract Review Request
    const extracted = extractReviewRequest({
      eventName,
      payload,
      botUsername: env.BOT_USERNAME,
      config: repoConfig.parsedJson,
    });

    if (!extracted) {
      // Handle specific PR closed events if needed (cleanup)
      if (eventName === 'pull_request') {
        const prPayload = payload as PullRequestWebhookPayload;
        if (prPayload.action === 'closed' && repoConfig.parsedJson.review.labels !== false) {
          const labels = repoConfig.parsedJson.review.labels;
          const gh = new GitHubClient(env, installationId);
          await gh.removeIssueLabel(prPayload.repository.owner.login, prPayload.repository.name, prPayload.pull_request.number, labels.p1);
          await gh.removeIssueLabel(prPayload.repository.owner.login, prPayload.repository.name, prPayload.pull_request.number, labels.p2);
          await gh.removeIssueLabel(prPayload.repository.owner.login, prPayload.repository.name, prPayload.pull_request.number, labels.p3);
        }
      }
      return;
    }

    // 3. Resolve full PR info for mentions
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

    // 4. Duplicate Check
    const duplicateJob = await findExistingJobForHead(env, {
      owner: resolved.owner,
      repo: resolved.repo,
      prNumber: resolved.prNumber,
      commitSha: resolved.commitSha,
      trigger: resolved.trigger,
    });
    if (duplicateJob) {
      if (duplicateJob.status === 'running') {
        logger.info(`Duplicate in-flight job ${duplicateJob.id} is already running for ${resolved.owner}/${resolved.repo} PR #${resolved.prNumber}.`);
        return;
      }
      if (duplicateJob.status === 'queued') {
        logger.info(`Resuming duplicate in-flight job ${duplicateJob.id} for ${resolved.owner}/${resolved.repo} PR #${resolved.prNumber}.`);
        job = duplicateJob;
      } else {
        logger.info(`Duplicate terminal job found for ${resolved.owner}/${resolved.repo} PR #${resolved.prNumber}, skipping.`);
        return;
      }
    } else {
      // 5. Insert Job
      job = await insertJob(env, {
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

      // 6. Supersede older jobs
      await supersedeOlderJobs(env, {
        installationId: resolved.installationId,
        owner: resolved.owner,
        repo: resolved.repo,
        prNumber: resolved.prNumber,
        newJobId: job.id,
      });
    }
  }

  const tracker = new TokenTracker();
  const github = new GitHubService(env, job.installationId, tracker);
  const model = new ModelService(env, tracker);
  const formatter = new FormatterService(env.APP_URL);

  let checkRunId = job.checkRunId;

  try {
    tracker.incrementSubrequests(1);
    const claimed = await startJobProcessing(env, job.id, 'Preparation');
    if (!claimed) {
      logger.info(`Job ${job.id} was already claimed or no longer queued, skipping duplicate queue delivery.`);
      return;
    }

    const pr = await github.getPullRequest(job.owner, job.repo, job.prNumber);
    const config = (job.configSnapshot ?? defaultRepoConfig) as RepoConfig;

    if (!checkRunId) {
      const checkRun = await github.createCheckRun(job.owner, job.repo, {
        headSha: pr.head.sha,
        title: 'Review queued',
        summary: 'Codra has started reviewing this pull request.',
      });
      checkRunId = checkRun.id;

      tracker.incrementSubrequests(1);
      await updateJobCheckRun(env, job.id, checkRun.id);
    }

    const rawDiff = await github.getPullRequestDiff(job.owner, job.repo, job.prNumber);
    const files = filterReviewableFiles(parseUnifiedDiff(rawDiff), config.review);

    tracker.incrementSubrequests(1);
    await completePreparationStep(env, job.id, files.length);

    tracker.incrementSubrequests(1);
    const preparedJob = await getJobForProcessing(env, job.id);
    if (preparedJob?.status === 'superseded') {
      throw new Error('JOB_SUPERSEDED');
    }

    tracker.incrementSubrequests(1);
    await updateJobStep(env, job.id, 'Reviewing Files', { status: 'running' });
    const reviewedComments: ParsedReviewComment[] = [];
    const fileSummaries: Array<{ path: string; summary: string; verdict: string }> = [];
    const newReviewsToInsert: any[] = [];
    let stoppedBeforeAllFiles = false;

    const jobIdsToQuery = [job.id];
    if (job.retryOfJobId) jobIdsToQuery.push(job.retryOfJobId);
    const allExistingReviews = await getFileReviewsForJobs(env, jobIdsToQuery);

    const currentJobReviews = allExistingReviews.filter(r => r.job_id === job.id);
    const existingReviews = [...currentJobReviews];
    for (const r of allExistingReviews) {
      if (r.job_id !== job.id && !existingReviews.some(er => er.file_path === r.file_path)) {
        existingReviews.push(r);
      }
    }

    const totalLineCount = files.reduce((sum, f) => sum + f.lineCount, 0);
    for (const [index, file] of files.entries()) {
      // Safety break to avoid hitting Cloudflare 50-subrequest limit
      if (!tracker.hasRemainingSubrequests(5)) {
        logger.warn(`Approaching subrequest limit (${tracker.getSubrequestCount()}), stopping review loop at file ${index + 1}/${files.length}`);
        stoppedBeforeAllFiles = true;
        break;
      }

      // Periodic check for supersession (every 50 files - reduced frequency to save subrequests)
      if (index % 50 === 0 && index > 0) {
        tracker.incrementSubrequests(1);
        const currentJob = await getJobForProcessing(env, job.id);
        if (currentJob?.status === 'superseded') {
          throw new Error('JOB_SUPERSEDED');
        }
      }

      const existing = existingReviews.find((r) => r.file_path === file.path && r.file_status === 'done');

      if (existing) {
        reviewedComments.push(...(existing.parsed_comments as ParsedReviewComment[]));
        fileSummaries.push({
          path: file.path,
          summary: existing.file_summary ?? '',
          verdict: existing.verdict ?? 'comment',
        });

        if (existing.model_used && (existing.input_tokens || existing.output_tokens)) {
          tracker.record(existing.model_used, existing.input_tokens ?? 0, existing.output_tokens ?? 0);
        }

        // If this review was from a parent job, we'll include it in our batch insert for the current job
        if (!currentJobReviews.some((r) => r.file_path === file.path)) {
          newReviewsToInsert.push({
            filePath: file.path,
            fileStatus: 'done',
            modelUsed: existing.model_used,
            modelProvider: (existing as any).model_provider,
            diffLineCount: existing.diff_line_count,
            diffInput: existing.diff_input,
            rawAiOutput: existing.raw_ai_output,
            parsedComments: existing.parsed_comments as ParsedReviewComment[],
            inputTokens: existing.input_tokens,
            outputTokens: existing.output_tokens,
            durationMs: existing.duration_ms,
            verdict: existing.verdict,
            fileSummary: existing.file_summary,
            overallCorrectness: existing.overall_correctness,
            confidenceScore: existing.confidence_score,
            errorMessage: null,
          });
        }
        continue;
      }

      // Update check run less frequently (every 50 files)
      if ((index > 0 && index % 50 === 0) || index === files.length - 1) {
        await github.updateCheckRun(job.owner, job.repo, checkRunId, {
          title: `Reviewing (${index + 1}/${files.length})`,
          summary: `Analyzing ${file.path}`,
        });
      }

      const startedAt = Date.now();
      try {
        // AI call (ModelService handles its own subrequest incrementing)
        const response = await model.reviewFile({
          file,
          prTitle: pr.title ?? null,
          prDescription: pr.body ?? null,
          config: config,
          totalLineCount,
        });

        reviewedComments.push(...response.parsed.comments);
        fileSummaries.push({
          path: file.path,
          summary: response.parsed.fileSummary,
          verdict: response.parsed.verdict,
        });

        newReviewsToInsert.push({
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
        logger.error(`File review failed for ${file.path}`, { error });

        // If we hit a hard limit (subrequests or neuron quota), STOP EVERYTHING.
        const isHardLimit =
          errorMessage.toLowerCase().includes('subrequest') ||
          errorMessage.includes('4006') ||
          errorMessage.toLowerCase().includes('allocation');

        if (isHardLimit) {
          throw error;
        }

        fileSummaries.push({
          path: file.path,
          summary: `Review failed: ${errorMessage}`,
          verdict: 'failed',
        });

        newReviewsToInsert.push({
          filePath: file.path,
          fileStatus: 'failed',
          modelUsed: config.model?.main ?? 'gemma-4-31b-it',
          modelProvider: (config.model?.main ?? 'gemma-4-31b-it').startsWith('@cf/') ? 'cloudflare' : 'google',
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

    // Batch insert all NEW or parent-inherited reviews at once (1 subrequest for reviews, 1 for comments)
    if (newReviewsToInsert.length > 0) {
      const { batchInsertFileReviews } = await import('@server/db/file-reviews');
      tracker.incrementSubrequests(2); // 1 for reviews, 1 for comments
      await batchInsertFileReviews(env, job.id, newReviewsToInsert);
    }

    if (stoppedBeforeAllFiles) {
      tracker.incrementSubrequests(1);
      await updateJobStep(env, job.id, 'Reviewing Files', {
        status: 'failed',
        error: 'Review stopped before all files were analyzed due to subrequest limits.',
      });
      throw new Error('Review stopped before all files were analyzed due to subrequest limits.');
    }

    if (fileSummaries.length > 0 && fileSummaries.every((f) => f.verdict === 'failed')) {
      tracker.incrementSubrequests(1);
      await updateJobStep(env, job.id, 'Reviewing Files', { status: 'failed', error: 'All files failed to review' });
      throw new Error('All files failed to review');
    }

    tracker.incrementSubrequests(1);
    await updateJobStep(env, job.id, 'Reviewing Files', { status: 'done' });

    tracker.incrementSubrequests(1);
    await updateJobStep(env, job.id, 'Generating Summary', { status: 'running' });
    const hasFailures = fileSummaries.some((f) => f.verdict === 'failed');
    const verdictSummary = formatter.summarizeVerdict(reviewedComments, hasFailures);

    // Final check before generating summary and posting review
    const finalJobCheck = await getJobForProcessing(env, job.id);
    if (finalJobCheck?.status === 'superseded') {
      throw new Error('JOB_SUPERSEDED');
    }

    const summaryResponse = await model.generateSummary({
      prTitle: pr.title ?? null,
      verdict: verdictSummary.verdict,
      fileSummaries,
      config,
    });

    await updateJobStep(env, job.id, 'Generating Summary', { status: 'done' });

    const formattedSummary = formatter.formatReviewOverview(pr.head.sha, env.BOT_USERNAME);

    await updateJobStep(env, job.id, 'Completing', { status: 'running' });
    const review = await github.createReview(job.owner, job.repo, job.prNumber, {
      commitSha: pr.head.sha,
      event: formatter.toReviewEvent(verdictSummary.verdict),
      body: formattedSummary,
      comments: reviewedComments.map(c => ({
        path: c.path,
        position: c.position ?? undefined,
        body: formatter.formatInlineComment(c)
      })),
    });

    if (config.review.labels !== false) {
      const labels = config.review.labels;
      const labelMap = {
        comment: { name: labels.p1, color: 'f79009' },
        approve: { name: labels.p2, color: '027a48' },
      } as const;
      const label = labelMap[verdictSummary.verdict];

      // Remove other verdict labels if they exist
      const allPotentialLabels = [labels.p1, labels.p2, labels.p3];
      for (const l of allPotentialLabels) {
        if (l !== label.name) {
          await github.removeIssueLabel(job.owner, job.repo, job.prNumber, l);
        }
      }

      await github.ensureLabel(job.owner, job.repo, label.name, label.color);
      await github.addIssueLabels(job.owner, job.repo, job.prNumber, [label.name]);
    }

    await github.updateCheckRun(job.owner, job.repo, checkRunId, {
      status: 'completed',
      conclusion: hasFailures ? 'failure' : (verdictSummary.verdict === 'approve' ? 'success' : 'neutral'),
      title: hasFailures ? 'Review partially failed' : (verdictSummary.verdict === 'approve' ? 'LGTM' : 'Comments posted'),
      summary: `${reviewedComments.length} inline comments across ${files.length} files.${hasFailures ? ' Some files failed to parse.' : ''}`,
    });

    const finalUsage = tracker.getTotalUsage();
    logger.info(`Final token usage for job ${job.id}:`, {
      total: finalUsage,
      breakdown: tracker.getBreakdown()
    });

    await completeJob(env, job.id, {
      verdict: verdictSummary.verdict,
      fileCount: files.length,
      commentCount: reviewedComments.length,
      totalInputTokens: finalUsage.input,
      totalOutputTokens: finalUsage.output,
      summaryMarkdown: formattedSummary,
      reviewId: review.id,
      summaryModel: summaryResponse.modelUsed,
    });
    await updateJobStep(env, job.id, 'Completing', { status: 'done' });
    logger.info(`Review job completed: ${job.owner}/${job.repo} PR #${job.prNumber}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown review failure';
    if (message === 'JOB_SUPERSEDED') {
      logger.info(`Job ${job.id} was superseded during execution, stopping.`);
      return;
    }

    logger.error(`Review job failed: ${job.owner}/${job.repo} PR #${job.prNumber}`, error);

    // Attempt to record failure, but don't crash if we are out of subrequests
    try {
      await failJob(env, job.id, message);
      if (checkRunId) {
        await github.updateCheckRun(job.owner, job.repo, checkRunId, {
          status: 'completed',
          conclusion: 'failure',
          title: 'Review failed',
          summary: message,
        });
      }
    } catch (innerError) {
      logger.error('Failed to record job failure in DB/GitHub (likely subrequest limit reached)', innerError);
    }
  }
}
