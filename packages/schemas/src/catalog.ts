import { z } from 'zod';
import { Id } from './common.js';

export const CatalogEntrySchema = z.object({
  id: Id,
  type: z.enum(['team', 'workflow', 'skill', 'plugin', 'mcp', 'tool']),
  description: z.string().min(1).max(200),
  tags: z.array(z.string()).default([]),
});
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;
