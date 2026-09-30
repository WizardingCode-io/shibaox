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
  /** MCP servers from the catalog (`type: mcp`) whose tools this role gets, in every runtime. */
  mcp: z.array(Id).default([]),
  /** Skills (`skills/<id>/SKILL.md` in the org) appended to this role's prompt. */
  skills: z.array(Id).default([]),
  /** Tool-loop steps for the direct adapter (default 12). */
  max_steps: z.number().int().positive().optional(),
  /** Agent turns for the Claude Code adapter (default 60). */
  max_turns: z.number().int().positive().optional(),
  /** Cap on what one task of this role may spend (USD), within the run budget. */
  budget_usd: z.number().positive().optional(),
  permissions: z
    .object({
      fs: z.array(z.string()).default(['workspace']),
      network: z.array(z.string()).default([]),
      approval_required: z.array(z.string()).default([]),
    })
    .default(() => ({ fs: ['workspace'], network: [], approval_required: [] })),
});
export type Role = z.infer<typeof RoleSchema>;
