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
  /**
   * Request routing by Jev on chat turns: `jev` on/off (default: on when TYPESAFE_API_KEY is
   * set and Jev decides), and the confidence from which a `cheap` route runs on the cheap tier.
   */
  routing: z
    .object({
      jev: z.boolean().optional(),
      cheap_min_confidence: z.number().min(0).max(1).optional(),
    })
    .optional(),
});
export type Models = z.infer<typeof ModelsSchema>;
