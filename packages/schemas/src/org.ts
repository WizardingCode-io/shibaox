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
});
export type OrgFile = z.infer<typeof OrgFileSchema>;
