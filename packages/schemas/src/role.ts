import { z } from 'zod';
import { Id, ModelTierSchema } from './common.js';

export const RoleSchema = z.object({
  role: Id,
  description: z.string().optional(),
  capabilities: z.array(z.string()).default([]),
  runtime: z.string().default('claude-code'),
  model_tier: ModelTierSchema.default('strong'),
  system_prompt: z.string().optional(),
  tools: z.array(z.string()).default([]),
  permissions: z
    .object({
      fs: z.array(z.string()).default(['workspace']),
      network: z.array(z.string()).default([]),
      approval_required: z.array(z.string()).default([]),
    })
    .default(() => ({ fs: ['workspace'], network: [], approval_required: [] })),
});
export type Role = z.infer<typeof RoleSchema>;
