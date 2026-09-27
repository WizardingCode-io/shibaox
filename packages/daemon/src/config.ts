import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';

export const DaemonConfigSchema = z.object({
  /** Runs that may execute at once across all orgs. */
  max_concurrent_runs: z.number().int().positive().default(4),
  /** A blocked approval past this is suspended (resumed by session id after the answer). */
  approval_timeout_minutes: z.number().positive().default(120),
  channels: z
    .object({
      macos: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
      telegram: z
        .object({
          bot_token_env: z.string().default('SHIBAOX_TELEGRAM_TOKEN'),
          chat_id: z.number().int(),
          /** Where text messages talk to the orchestrator: an org directory and a project. */
          org: z.string().optional(),
          project: z.string().optional(),
          workflow: z.string().default('chat'),
          adapter: z.enum(['mock', 'direct', 'claude-code']).optional(),
        })
        .optional(),
    })
    .default({ macos: { enabled: true } }),
});
export type DaemonConfig = z.infer<typeof DaemonConfigSchema>;

/** `daemon.yaml`; a missing file means the defaults. */
export function loadDaemonConfig(path: string): DaemonConfig {
  const raw = existsSync(path) ? (parse(readFileSync(path, 'utf8')) ?? {}) : {};
  const r = DaemonConfigSchema.safeParse(raw);
  if (!r.success)
    throw new Error(
      `invalid daemon config ${path}: ${r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
    );
  return r.data;
}
