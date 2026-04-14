import { logger } from './logger';

export interface TokenUsage {
  input: number;
  output: number;
}

export interface ModelUsage extends TokenUsage {
  model: string;
  calls: number;
}

export class TokenTracker {
  private usage: Map<string, ModelUsage> = new Map();

  /**
   * Records token usage for a specific model call.
   */
  record(model: string, input: number, output: number) {
    const existing = this.usage.get(model) || { model, input: 0, output: 0, calls: 0 };
    
    this.usage.set(model, {
      model,
      input: existing.input + input,
      output: existing.output + output,
      calls: existing.calls + 1,
    });

    logger.debug(`Token usage recorded for ${model}`, { 
      input, 
      output, 
      totalInput: existing.input + input,
      totalOutput: existing.output + output
    });
  }

  /**
   * Returns the total usage across all models.
   */
  getTotalUsage(): TokenUsage {
    let input = 0;
    let output = 0;
    for (const modelUsage of this.usage.values()) {
      input += modelUsage.input;
      output += modelUsage.output;
    }
    return { input, output };
  }

  /**
   * Returns a breakdown of usage by model.
   */
  getBreakdown(): ModelUsage[] {
    return Array.from(this.usage.values());
  }

  /**
   * Merges another tracker's usage into this one.
   * Useful when combining results from retries or sub-tasks.
   */
  merge(other: TokenTracker) {
    for (const usage of other.getBreakdown()) {
      this.record(usage.model, usage.input, usage.output);
    }
  }

  /**
   * Resets all usage data.
   */
  reset() {
    this.usage.clear();
  }
}
