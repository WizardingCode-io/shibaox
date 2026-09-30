import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

/** A second, network listener next to the Unix socket: same API, bearer token required. */
export const ListenSchema = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.number().int().min(0).max(65535).default(7433),
  /** The env/vault variable holding the bearer token every remote call must carry. */
  token_env: z.string().default('SHIBAOX_DAEMON_TOKEN'),
  /** PEM files; without them the listener is plain HTTP (put a TLS proxy in front, or use a VPN). */
  tls: z.object({ cert: z.string(), key: z.string() }).optional(),
});
export type ListenConfig = z.infer<typeof ListenSchema>;

export const DaemonConfigSchema = z.object({
  /** Runs that may execute at once across all orgs. */
  max_concurrent_runs: z.number().int().positive().default(4),
  listen: ListenSchema.optional(),
  /** Projects a remote dashboard can pick from (paths on the daemon's machine). */
  projects: z.array(z.string()).default([]),
  /** A directory whose git repositories are all offered as projects (a mounted /projects). */
  projects_dir: z.string().optional(),
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
  // relative org/project mean "next to this file", never the daemon's working directory
  const here = dirname(resolve(path));
  const tg = r.data.channels.telegram;
  if (tg) {
    if (tg.org) tg.org = resolve(here, tg.org);
    if (tg.project) tg.project = resolve(here, tg.project);
  }
  r.data.projects = r.data.projects.map((p) => resolve(here, p));
  if (r.data.projects_dir) r.data.projects_dir = resolve(here, r.data.projects_dir);
  if (r.data.listen?.tls) {
    r.data.listen.tls.cert = resolve(here, r.data.listen.tls.cert);
    r.data.listen.tls.key = resolve(here, r.data.listen.tls.key);
  }
  return r.data;
}
