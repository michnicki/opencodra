import type { AppBindings } from '@server/env';

export type ModelResponse = {
  rawText: string;
  inputTokens: number;
  outputTokens: number;
  modelUsed: string;
};

export async function reviewWithGemma(
  env: Pick<AppBindings, 'GEMINI_API_KEY'> & { GEMINI_MODEL?: string },
  input: { systemPrompt: string; userPrompt: string },
) {
  const model = env.GEMINI_MODEL || 'gemma-4-31b-it';
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: input.systemPrompt }],
        },
        contents: [
          {
            role: 'user',
            parts: [{ text: input.userPrompt }],
          },
        ],
        generationConfig: {
          responseMimeType: 'application/json',
          maxOutputTokens: 2048,
        },
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`Gemma request failed with ${response.status}`);
  }

  const data = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
    };
  };

  const rawText = data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('')?.trim();
  if (!rawText) {
    throw new Error('Gemma returned an empty response.');
  }

  return {
    rawText,
    inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
    modelUsed: model,
  } satisfies ModelResponse;
}
