import { z } from 'zod';
import { Id } from './common.js';

export const TeamSchema = z.object({
  team: Id,
  description: z.string().optional(),
  lead: Id,
  roles: z.array(Id).min(1),
  gates: z.array(Id).default([]),
  workflows: z.array(Id).default([]),
});
export type Team = z.infer<typeof TeamSchema>;
