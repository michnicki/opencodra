import type { AppBindings } from '@server/env';
import type { ModelResponse } from './gemma';

export async function reviewWithKimi(
  env: Pick<AppBindings, 'AI'>,
  input: { systemPrompt: string; userPrompt: string },
) {
  const result = await env.AI.run('@cf/moonshotai/kimi-k2.5', {
    messages: [
      { role: 'system', content: input.systemPrompt },
      { role: 'user', content: input.userPrompt },
    ],
    max_completion_tokens: 2048,
  });

  const rawText =
    result?.response ??
    result?.result?.response ??
    result?.choices?.[0]?.message?.content ??
    (typeof result === 'string' ? result : JSON.stringify(result));

  return {
    rawText,
    inputTokens: result?.usage?.prompt_tokens ?? result?.result?.usage?.prompt_tokens ?? 0,
    outputTokens: result?.usage?.completion_tokens ?? result?.result?.usage?.completion_tokens ?? 0,
    modelUsed: '@cf/moonshotai/kimi-k2.5',
  } satisfies ModelResponse;
}
