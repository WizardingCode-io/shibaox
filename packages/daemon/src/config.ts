import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { readDoc, syntaxErrorOf, writeAtomic } from './yaml-file.js';

/** A config file that does not parse: the caller must fix it first (HTTP 409). */
export class ConfigSyntaxError extends Error {
  override readonly name = 'ConfigSyntaxError';
}

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

/** Where "Create an account" sends people without a Higgsfield account (the maintainer's affiliate link). */
export const HIGGSFIELD_SIGNUP_URL = 'https://higgsfield.ai?fpr=andre-4fae29';

/**
 * How Higgsfield generates: `account` (the CLI login, plan credits, the remote MCP), `api` (a
 * developer key from open.higgsfield.ai, REST through the daemon's tools) or `auto` (the API when
 * a key is saved, else the account).
 */
export const HIGGSFIELD_MODES = ['auto', 'account', 'api'] as const;
export type HiggsfieldMode = (typeof HIGGSFIELD_MODES)[number];

/** Where Shibaox sends people who need an account with a partner (an affiliate link), and how Higgsfield is used. */
export const PartnersSchema = z
  .object({
    higgsfield: z
      .object({
        signup_url: z.string().url().default(HIGGSFIELD_SIGNUP_URL),
        mode: z.enum(HIGGSFIELD_MODES).default('auto'),
      })
      .default({ signup_url: HIGGSFIELD_SIGNUP_URL, mode: 'auto' }),
  })
  .default({ higgsfield: { signup_url: HIGGSFIELD_SIGNUP_URL, mode: 'auto' } });

export const DaemonConfigSchema = z.object({
  partners: PartnersSchema,
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
      /** Reports of runs asked from an issue (`run --issue`) as comments on it. */
      github: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
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
    .default({ macos: { enabled: true }, github: { enabled: true } }),
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

/** What the daemon itself changes in `daemon.yaml` (everything else is the user's to edit). */
export interface DaemonConfigPatch {
  higgsfieldMode?: HiggsfieldMode;
  /** The chat a pairing found (`channels.telegram.chat_id`); `bot_token_env` only when given. */
  telegram?: { chat_id: number; bot_token_env?: string };
}

/**
 * Applies `patch` to `daemon.yaml`, keeping comments and every other key; the patched document
 * is checked before anything touches the disk, so a refused change leaves the file as it was.
 */
export function writeDaemonConfig(path: string, patch: DaemonConfigPatch): DaemonConfig {
  const doc = readDoc(path);
  // a hand-edited file with a syntax error is never rewritten (it would lose what it says)
  const syntax = syntaxErrorOf(doc, path);
  if (syntax) throw new ConfigSyntaxError(syntax);
  if (patch.higgsfieldMode !== undefined) {
    if (!(HIGGSFIELD_MODES as readonly string[]).includes(patch.higgsfieldMode))
      throw new Error(
        `partners.higgsfield.mode must be one of ${HIGGSFIELD_MODES.join(', ')} (got "${String(patch.higgsfieldMode)}")`,
      );
    doc.setIn(['partners', 'higgsfield', 'mode'], patch.higgsfieldMode);
  }
  if (patch.telegram !== undefined) {
    doc.setIn(['channels', 'telegram', 'chat_id'], patch.telegram.chat_id);
    if (patch.telegram.bot_token_env !== undefined)
      doc.setIn(['channels', 'telegram', 'bot_token_env'], patch.telegram.bot_token_env);
  }
  const r = DaemonConfigSchema.safeParse(doc.toJS() ?? {});
  if (!r.success)
    throw new Error(
      `invalid daemon config ${path}: ${r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
    );
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeAtomic(path, doc.toString());
  return loadDaemonConfig(path);
}
