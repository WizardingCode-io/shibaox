import { z } from 'zod';
import { Id } from './common.js';

const base = { name: Id };
export const CheckSchema = z.discriminatedUnion('type', [
  z.object({
    ...base,
    type: z.literal('code'),
    command: z.string().min(1),
    timeout_ms: z.number().int().positive().default(300_000),
  }),
  z.object({
    ...base,
    type: z.literal('jev'),
    question: z.string().min(1),
    kind: z.enum(['noul', 'score']).default('noul'),
    threshold: z.number().min(0).max(1).default(0.8),
  }),
  z.object({ ...base, type: z.literal('judge'), role: Id, rubric: z.string().min(1) }),
  z.object({ ...base, type: z.literal('human'), prompt: z.string().min(1) }),
  z.object({
    ...base,
    type: z.literal('mock'),
    passes: z.boolean(),
    evidence: z.string().default('mock check'),
  }),
]);
export type Check = z.infer<typeof CheckSchema>;

export const GateSchema = z.object({
  gate: Id,
  description: z.string().optional(),
  checks: z.array(CheckSchema).min(1),
});
export type Gate = z.infer<typeof GateSchema>;
