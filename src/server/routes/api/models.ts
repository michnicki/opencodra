import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '@server/env';
import { listModelConfigs, updateModelConfig } from '@server/db/model-configs';
import { jsonError } from '@server/core/http';
import { getGlobalConfig, updateGlobalConfig } from '@server/core/config';

const providerSchema = z.enum(['google', 'cloudflare']);
const positiveIntegerSchema = z.number().int().positive().finite();
const modelIdSchema = z.string().trim().min(1);

const modelConfigUpdateSchema = z.object({
  rpm: positiveIntegerSchema,
  tpm: positiveIntegerSchema,
  rpd: positiveIntegerSchema,
  provider: providerSchema,
}).strict();

const globalModelConfigSchema = z.object({
  main: modelIdSchema.nullable().default('gemma-4-31b-it'),
  fallbacks: z.array(modelIdSchema).nullable().default([]),
  size_overrides: z
    .array(
      z.object({
        max_lines: positiveIntegerSchema,
        model: modelIdSchema,
        fallbacks: z.array(modelIdSchema).optional(),
      }).strict(),
    )
    .nullable()
    .optional(),
}).strict();

export function createModelsRouter() {
  const app = new Hono<AppEnv>();

  app.get('/', async (c) => {
    const configs = await listModelConfigs(c.env);
    return c.json({ configs });
  });
  
  app.get('/global', async (c) => {
    const config = await getGlobalConfig(c.env);
    return c.json({ config });
  });

  app.patch('/global', async (c) => {
    const body = await c.req.json();
    const parsed = globalModelConfigSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError('Invalid global model config.', 400);
    }

    await updateGlobalConfig(c.env, parsed.data);
    return c.json({ ok: true });
  });

  app.post('/:id', async (c) => {
    const modelId = c.req.param('id');
    const parsedModelId = modelIdSchema.safeParse(modelId);
    if (!parsedModelId.success) {
      return jsonError('Invalid model id.', 400);
    }

    const body = await c.req.json();
    const parsed = modelConfigUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError('Invalid model config.', 400);
    }
    
    await updateModelConfig(c.env, {
      modelId: parsedModelId.data,
      ...parsed.data,
    });
    
    return c.json({ ok: true });
  });

  return app;
}
