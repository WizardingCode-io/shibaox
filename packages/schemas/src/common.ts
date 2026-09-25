import { z } from 'zod';

export const Id = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9:_-]*$/i, 'ids use letters, digits, - _ :');
export const ModelTierSchema = z.enum(['strong', 'cheap', 'local', 'decision']);
export type ModelTier = z.infer<typeof ModelTierSchema>;
