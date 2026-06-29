import type { AppBindings } from '@server/env';
import { logger } from './logger';

const TELEMETRY_SECRET = 'codra-telemetry-v1-secret-8f9a2b5c';
const INSTANCE_ID_KEY = 'codra:instance_id';

/**
 * Returns a stable, anonymous instance ID.
 * Generates and stores one in KV if it doesn't exist yet.
 */
export async function getInstanceId(env: AppBindings): Promise<string> {
  try {
    let instanceId = await env.APP_KV.get(INSTANCE_ID_KEY);
    if (!instanceId) {
      instanceId = crypto.randomUUID();
      await env.APP_KV.put(INSTANCE_ID_KEY, instanceId);
    }
    return instanceId;
  } catch (error) {
    logger.warn('Failed to retrieve or generate instance ID for telemetry', {
      error: error instanceof Error ? error.message : String(error),
    });
    // Fallback to a random UUID so telemetry can still send, though it will
    // count as a new "install" if KV is failing.
    return crypto.randomUUID();
  }
}

/**
 * Sends an anonymous telemetry event to Codra Core backend.
 * Swallows all errors so the caller is never interrupted.
 */
export async function sendTelemetryEvent(
  env: AppBindings,
  data: { 
    linesReviewed: number; 
    findingsReported: number; 
    inputTokens: number; 
    outputTokens: number;
    modelsUsed: string[];
    fileExtensions: string[];
    triggerType: string;
    reviewDurationMs: number;
    filesReviewed: number;
    verdict?: string;
    severityDistribution: Record<string, number>;
  },
): Promise<void> {
  try {
    const instanceId = await getInstanceId(env);
    // Use an environment variable if available, otherwise default to the hosted backend
    const telemetryUrl = (env as any).TELEMETRY_API_URL ?? 'https://codra.run/api/telemetry';

    // Fire and forget using standard fetch with a timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    await fetch(telemetryUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TELEMETRY_SECRET}`,
      },
      body: JSON.stringify({
        instanceId,
        prsReviewed: 1,
        linesReviewed: data.linesReviewed,
        findingsReported: data.findingsReported,
        inputTokens: data.inputTokens,
        outputTokens: data.outputTokens,
        modelsUsed: data.modelsUsed,
        fileExtensions: data.fileExtensions,
        triggerType: data.triggerType,
        reviewDurationMs: data.reviewDurationMs,
        filesReviewed: data.filesReviewed,
        verdict: data.verdict,
        severityDistribution: data.severityDistribution,
      }),
      signal: controller.signal,
    }).catch((error) => {
      // Intentionally swallowed: Network errors are expected occasionally
      logger.debug('Failed to send anonymous telemetry event (network)', {
        error: error instanceof Error ? error.message : String(error),
      });
    }).finally(() => {
      clearTimeout(timeoutId);
    });
  } catch (error) {
    // Intentionally swallowed: We never want telemetry to fail a PR review
    logger.debug('Failed to send anonymous telemetry event (setup)', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
