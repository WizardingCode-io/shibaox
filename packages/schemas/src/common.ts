import { z } from 'zod';

export const Id = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9:_-]*$/i, 'ids use letters, digits, - _ :');
export const ModelTierSchema = z.enum(['strong', 'cheap', 'local', 'decision']);
export type ModelTier = z.infer<typeof ModelTierSchema>;

/** One turn of a conversation with the orchestrator (what the dashboard sends as `messages`). */
export const ChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  /** A condensation of older turns the daemon folded away (one per conversation, first). */
  summary: z.boolean().optional(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
