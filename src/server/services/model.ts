import type { AppBindings } from '../env';
import { reviewWithGemma } from '../models/gemma';
import { reviewWithKimi } from '../models/kimi';
import { buildFileReviewPrompts } from '../prompts/file-review';
import { buildSummaryPrompt, SUMMARY_SYSTEM_PROMPT } from '../prompts/summary';
import { parseFileReviewResponse } from '../core/model-output';
import type { RepoConfig } from '@shared/schema';
import type { TokenTracker } from '../core/token-tracker';

export class ModelService {
  constructor(private env: AppBindings, private tracker?: TokenTracker) {}

  async reviewFile(params: {
    file: any;
    prTitle: string | null;
    prDescription: string | null;
    config: RepoConfig['review'];
  }) {
    const { systemPrompt, userPrompt } = buildFileReviewPrompts(params);

    const isLargeFile = params.file.lineCount >= params.config.large_file_threshold_lines;
    const response = isLargeFile
      ? await reviewWithKimi(this.env, { systemPrompt, userPrompt })
      : await reviewWithGemma(this.env, { systemPrompt, userPrompt });

    if (this.tracker) {
      this.tracker.record(response.modelUsed, response.inputTokens, response.outputTokens);
    }

    const parsed = parseFileReviewResponse(response.rawText, params.file);

    return {
      ...response,
      parsed,
      userPrompt, // useful for DB insertion
    };
  }

  async generateSummary(params: {
    prTitle: string | null;
    verdict: 'approve' | 'comment';
    fileSummaries: Array<{ path: string; summary: string; verdict: string }>;
  }) {
    const response = await reviewWithGemma(this.env, {
      systemPrompt: SUMMARY_SYSTEM_PROMPT,
      userPrompt: buildSummaryPrompt(params),
    });

    if (this.tracker) {
      this.tracker.record(response.modelUsed, response.inputTokens, response.outputTokens);
    }

    return response;
  }
}
