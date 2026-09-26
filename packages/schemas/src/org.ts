import { z } from 'zod';
import { Id } from './common.js';

export const OrgFileSchema = z.object({
  organization: Id,
  budgets: z
    .object({
      monthly_usd: z.number().positive().optional(),
      per_run_usd: z.number().positive().optional(),
    })
    .default({}),
  teams: z.array(Id).default([]),
  /** Runtime adapter for task nodes when `--adapter` is not passed (default: mock). */
  adapter: z.enum(['mock', 'direct', 'claude-code']).optional(),
  /** Runs of this org that may execute at once in the daemon (default 2). */
  max_concurrent_runs: z.number().int().positive().optional(),
  /** Obsidian vault path (relative to the org root, or absolute) for run notes. */
  vault: z.string().optional(),
});
export type OrgFile = z.infer<typeof OrgFileSchema>;
