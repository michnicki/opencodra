import type { GitHubWebhookEventName, GitHubWebhookPayload, IssueCommentWebhookPayload, PullRequestWebhookPayload } from '@shared/github';
import { defaultRepoConfig, type ParsedReviewComment, type RepoConfig, type ReviewJobMessage } from '@shared/schema';
import type { AppBindings } from '@server/env';
import { insertFileReview } from '@server/db/file-reviews';
import { completeJob, failJob, getJobForProcessing, markJobRunning, updateJobCheckRun } from '@server/db/jobs';
import { filterReviewableFiles, parseUnifiedDiff } from './diff';
import { GitHubClient } from './github';
import { parseFileReviewResponse } from './model-output';
import { buildFileReviewPrompt, FILE_REVIEW_SYSTEM_PROMPT } from '@server/prompts/file-review';
import { buildSummaryPrompt, SUMMARY_SYSTEM_PROMPT } from '@server/prompts/summary';
import { reviewWithGemma } from '@server/models/gemma';
import { reviewWithKimi } from '@server/models/kimi';

function severityIcon(severity: ParsedReviewComment['severity']) {
  switch (severity) {
    case 'error':
      return '🔴';
    case 'warning':
      return '🟡';
    case 'suggestion':
      return '🔵';
    default:
      return '⚪';
  }
}

function formatInlineComment(comment: ParsedReviewComment) {
  return `${severityIcon(comment.severity)} [${comment.category.toUpperCase()}] ${comment.title}\n\n${comment.body}`;
}

function toReviewEvent(verdict: 'approve' | 'comment' | 'request_changes') {
  switch (verdict) {
    case 'approve':
      return 'APPROVE' as const;
    case 'request_changes':
      return 'REQUEST_CHANGES' as const;
    default:
      return 'COMMENT' as const;
  }
}

function summarizeVerdict(comments: ParsedReviewComment[], hasFailures: boolean) {
  const errors = comments.filter((comment) => comment.severity === 'error').length;
  const warnings = comments.filter((comment) => comment.severity === 'warning').length;

  if (errors > 0) {
    return { verdict: 'request_changes' as const, errors, warnings };
  }
  
  if (hasFailures) {
    return { verdict: 'comment' as const, errors, warnings };
  }

  if (warnings > 0) {
    return { verdict: 'comment' as const, errors, warnings };
  }
  
  return { verdict: 'approve' as const, errors, warnings };
}

function shouldTriggerFromPullRequest(action: PullRequestWebhookPayload['action'], config: RepoConfig['review']) {
  return config.on.includes(action);
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
  const job = await getJobForProcessing(env, message.jobId);
  if (!job) {
    return;
  }

  const github = new GitHubClient(env, job.installation_id);
  let checkRunId = job.check_run_id;

  try {
    await markJobRunning(env, job.id);

    const pr = await github.getPullRequest(job.owner, job.repo, job.pr_number);
    const config = (job.config_snapshot ?? defaultRepoConfig) as RepoConfig;

    if (!checkRunId) {
      const checkRun = await github.createCheckRun(job.owner, job.repo, {
        headSha: pr.head.sha,
        title: 'Review queued',
        summary: 'Codra has started reviewing this pull request.',
      });
      checkRunId = checkRun.id;
      await updateJobCheckRun(env, job.id, checkRun.id);
    }

    const rawDiff = await github.getPullRequestDiff(job.owner, job.repo, job.pr_number);
    const files = filterReviewableFiles(parseUnifiedDiff(rawDiff), config.review);

    const reviewedComments: ParsedReviewComment[] = [];
    const fileSummaries: Array<{ path: string; summary: string; verdict: string }> = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    for (const [index, file] of files.entries()) {
      await github.updateCheckRun(job.owner, job.repo, checkRunId, {
        title: `Reviewing (${index + 1}/${files.length})`,
        summary: `Analyzing ${file.path}`,
      });

      const startedAt = Date.now();

      try {
        const userPrompt = buildFileReviewPrompt({
          file,
          prTitle: pr.title,
          prDescription: pr.body,
          config: config.review,
        });
        const response =
          file.lineCount >= config.review.large_file_threshold_lines
            ? await reviewWithKimi(env, { systemPrompt: FILE_REVIEW_SYSTEM_PROMPT, userPrompt })
            : await reviewWithGemma(env, { systemPrompt: FILE_REVIEW_SYSTEM_PROMPT, userPrompt });

        totalInputTokens += response.inputTokens;
        totalOutputTokens += response.outputTokens;

        const parsed = parseFileReviewResponse(response.rawText, file);
        const formattedComments = parsed.comments.map((comment) => ({
          ...comment,
          body: formatInlineComment(comment),
        }));

        reviewedComments.push(...formattedComments);
        fileSummaries.push({
          path: file.path,
          summary: parsed.fileSummary,
          verdict: parsed.verdict,
        });

        await insertFileReview(env, {
          jobId: job.id,
          filePath: file.path,
          fileStatus: 'done',
          modelUsed: response.modelUsed,
          diffLineCount: file.lineCount,
          diffInput: userPrompt,
          rawAiOutput: response.rawText,
          parsedComments: formattedComments,
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
          durationMs: Date.now() - startedAt,
          verdict: parsed.verdict,
          fileSummary: parsed.fileSummary,
          errorMessage: null,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown file review error';
        fileSummaries.push({
          path: file.path,
          summary: `Review failed: ${errorMessage}`,
          verdict: 'failed',
        });

        await insertFileReview(env, {
          jobId: job.id,
          filePath: file.path,
          fileStatus: 'failed',
          modelUsed: file.lineCount >= config.review.large_file_threshold_lines ? '@cf/moonshotai/kimi-k2.5' : env.GEMINI_MODEL || 'gemma-4-31b-it',
          diffLineCount: file.lineCount,
          diffInput: null,
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

    const hasFailures = fileSummaries.some((f) => f.verdict === 'failed');
    const verdictSummary = summarizeVerdict(reviewedComments, hasFailures);
    const summaryResponse = await reviewWithGemma(env, {
      systemPrompt: SUMMARY_SYSTEM_PROMPT,
      userPrompt: buildSummaryPrompt({
        prTitle: pr.title,
        verdict: verdictSummary.verdict,
        errorCount: verdictSummary.errors,
        warningCount: verdictSummary.warnings,
        totalComments: reviewedComments.length,
        fileSummaries,
      }),
    });

    totalInputTokens += summaryResponse.inputTokens;
    totalOutputTokens += summaryResponse.outputTokens;

    const review = await github.createReview(job.owner, job.repo, job.pr_number, {
      commitSha: pr.head.sha,
      event: toReviewEvent(verdictSummary.verdict),
      body: summaryResponse.rawText,
      comments: reviewedComments,
    });

    if (config.review.labels !== false) {
      const labelMap = {
        request_changes: { name: config.review.labels.p1, color: 'b42318' },
        comment: { name: config.review.labels.p2, color: 'f79009' },
        approve: { name: config.review.labels.p3, color: '027a48' },
      } as const;
      const label = labelMap[verdictSummary.verdict];
      await github.ensureLabel(job.owner, job.repo, label.name, label.color);
      await github.addIssueLabels(job.owner, job.repo, job.pr_number, [label.name]);
    }

    await github.updateCheckRun(job.owner, job.repo, checkRunId, {
      status: 'completed',
      conclusion:
        verdictSummary.verdict === 'request_changes'
          ? 'failure'
          : verdictSummary.verdict === 'comment'
            ? 'neutral'
            : 'success',
      title:
        verdictSummary.verdict === 'request_changes'
          ? 'Changes requested'
          : verdictSummary.verdict === 'comment'
            ? 'Comments posted'
            : 'LGTM',
      summary: `${reviewedComments.length} inline comments across ${files.length} files.`,
    });

    await completeJob(env, job.id, {
      verdict: verdictSummary.verdict,
      fileCount: files.length,
      commentCount: reviewedComments.length,
      totalInputTokens,
      totalOutputTokens,
      summaryMarkdown: summaryResponse.rawText,
      reviewId: review.id,
      summaryModel: summaryResponse.modelUsed,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown review failure';
    await failJob(env, job.id, message);

    if (checkRunId) {
      await github.updateCheckRun(job.owner, job.repo, checkRunId, {
        status: 'completed',
        conclusion: 'failure',
        title: 'Review failed',
        summary: message,
      });
    }
  }
}
