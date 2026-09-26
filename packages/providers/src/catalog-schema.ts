import { z } from 'zod';

export const ProviderKindSchema = z.enum([
  'openai-compatible',
  'openai',
  'anthropic',
  'google',
  'xai',
  'azure',
  'bedrock',
  'vertex',
  'vertex-anthropic',
  'groq',
  'mistral',
  'cohere',
  'deepseek',
  'cerebras',
  'deepinfra',
  'fireworks',
  'togetherai',
  'moonshotai',
  'alibaba',
  'minimax',
  'huggingface',
  'perplexity',
  'zai',
  'openrouter',
]);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

export const ProviderAuthSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('api_key'), env: z.string().min(1) }),
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('aws') }),
  z.object({ type: z.literal('gcp') }),
  z.object({ type: z.literal('azure') }),
]);
export type ProviderAuth = z.infer<typeof ProviderAuthSchema>;

export const ProviderEntrySchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    name: z.string().min(1),
    kind: ProviderKindSchema.optional(),
    via_runtime: z.string().optional(),
    base_url: z.string().url().optional(),
    base_url_env: z.string().optional(),
    auth: ProviderAuthSchema.optional(),
    models: z.array(z.string()).default([]),
    pricing: z
      .record(
        z.string(),
        z.object({ input_per_m: z.number().min(0), output_per_m: z.number().min(0) }),
      )
      .default({}),
    verify: z.boolean().default(false),
    /** Model-calling capabilities; `tools: false` marks a provider/model that cannot use function/tool calling (the direct adapter then runs it text-only). */
    capabilities: z.object({ tools: z.boolean().default(true) }).default({ tools: true }),
    notes: z.string().optional(),
  })
  .superRefine((e, ctx) => {
    if (e.via_runtime) {
      if (e.kind)
        ctx.addIssue({ code: 'custom', message: `${e.id}: via_runtime entries must not set kind` });
      return;
    }
    if (!e.kind)
      ctx.addIssue({ code: 'custom', message: `${e.id}: kind is required for direct providers` });
    if (!e.auth)
      ctx.addIssue({ code: 'custom', message: `${e.id}: auth is required for direct providers` });
    if (e.kind === 'openai-compatible' && !e.base_url && !e.base_url_env)
      ctx.addIssue({
        code: 'custom',
        message: `${e.id}: openai-compatible needs base_url or base_url_env`,
      });
  });
export type ProviderEntry = z.infer<typeof ProviderEntrySchema>;
export const CatalogSchema = z.array(ProviderEntrySchema);
