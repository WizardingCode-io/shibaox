import { z } from 'zod';
import { ModelTierSchema } from './common.js';

export const ModelsSchema = z.object({
  providers: z
    .record(
      z.string(),
      z.object({ api_key_env: z.string().optional(), base_url: z.string().optional() }),
    )
    .default({}),
  tiers: z.partialRecord(ModelTierSchema, z.string()).default({}),
  roles: z
    .record(z.string(), z.object({ model: z.string(), runtime: z.string().optional() }))
    .default({}),
  gates: z.record(z.string(), z.string()).default({}),
});
export type Models = z.infer<typeof ModelsSchema>;
