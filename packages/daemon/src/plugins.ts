import { accessSync, constants, statSync } from 'node:fs';
import { join } from 'node:path';
import { augmentPath } from '@wizardingcode/shibaox-core';
import type { HiggsfieldView } from './higgsfield.js';
import type { DeciderInfo } from './runtime.js';

/** A partner integration with its own setup (a CLI, an account, keys), and what it brings. */
export interface PluginRow {
  id: string;
  name: string;
  description: string;
  /** `ready`: every check passes; `partial`: some do; `off`: none. */
  status: 'ready' | 'partial' | 'off';
  checks: { label: string; ok: boolean; detail?: string }[];
  keys: { name: string; present: boolean }[];
  /** `href` opens (an absolute URL) or is POSTed (a daemon path); `command` is copied. */
  actions: { id: string; label: string; href?: string; command?: string }[];
  brings: { connectors: string[]; skills: string[] };
}

/** What the plugin status is made of (tests inject fakes; the daemon passes its probes). */
export interface PluginChecks {
  higgsfield(): Promise<HiggsfieldView>;
  /** The path of an executable on the (augmented) PATH, or undefined. */
  which(cmd: string): Promise<string | undefined>;
  /** The daemon's environment with the vault on top (only presence is read). */
  env: NodeJS.ProcessEnv;
  decider(): Promise<DeciderInfo | undefined>;
}

/** `which` without a shell: the first executable file named `cmd` on PATH (plus the user bins). */
export function whichOnPath(env: NodeJS.ProcessEnv): (cmd: string) => Promise<string | undefined> {
  return async (cmd) => {
    for (const dir of augmentPath(env.PATH, env.HOME).split(':')) {
      const p = join(dir, cmd);
      try {
        if (!statSync(p).isFile()) continue;
        accessSync(p, constants.X_OK);
        return p;
      } catch {
        // not here
      }
    }
    return undefined;
  };
}

const present = (env: NodeJS.ProcessEnv, name: string) =>
  typeof env[name] === 'string' && env[name] !== '';

const statusOf = (checks: { ok: boolean }[]): PluginRow['status'] => {
  const ok = checks.filter((c) => c.ok).length;
  return ok === checks.length ? 'ready' : ok > 0 ? 'partial' : 'off';
};

const safe = async <T>(p: () => Promise<T>): Promise<T | undefined> => {
  try {
    return await p();
  } catch {
    return undefined;
  }
};

const WIKI = 'https://github.com/WizardingCode-io/shibaox/wiki';

/** The status of every built-in plugin: Higgsfield, GitHub, Telegram, TypeSafe / Jev. */
export async function pluginsStatus(c: PluginChecks): Promise<PluginRow[]> {
  const [hf, gh, decider] = await Promise.all([
    safe(c.higgsfield),
    safe(() => c.which('gh')),
    safe(c.decider),
  ]);
  const rows: Omit<PluginRow, 'status'>[] = [];

  rows.push({
    id: 'higgsfield',
    name: 'Higgsfield',
    description: 'Images, video, audio and 3D from 40+ models, on your Higgsfield account.',
    checks: [
      {
        label: 'CLI installed',
        ok: !!hf?.cli.installed,
        ...(hf?.cli.version ? { detail: hf.cli.version } : {}),
      },
      {
        label: 'Logged in',
        ok: !!hf?.loggedIn,
        ...(hf?.account
          ? { detail: `${hf.account.email} · ${hf.account.plan} · ${hf.account.credits} credits` }
          : {}),
      },
      { label: 'MCP reachable', ok: hf?.mcp === 'ok', detail: hf?.mcp ?? 'unreachable' },
    ],
    keys: [],
    actions: [
      { id: 'install', label: 'Install command', ...(hf ? { command: hf.installCommand } : {}) },
      { id: 'login', label: 'Log in', href: '/integrations/higgsfield/login' },
      { id: 'signup', label: 'Create account', ...(hf ? { href: hf.signupUrl } : {}) },
      { id: 'open', label: 'Open Higgsfield', href: hf?.site ?? 'https://higgsfield.ai' },
    ],
    brings: { connectors: ['higgsfield'], skills: ['higgsfield'] },
  });

  const ghKeys = ['GH_TOKEN', 'GITHUB_TOKEN'].map((name) => ({
    name,
    present: present(c.env, name),
  }));
  rows.push({
    id: 'github',
    name: 'GitHub',
    description: 'Issues to runs, pull requests, reviews, CI checks and merges (the GitHub loop).',
    checks: [
      { label: 'gh installed', ok: !!gh, ...(gh ? { detail: gh } : {}) },
      {
        label: 'Token (GH_TOKEN or GITHUB_TOKEN)',
        ok: ghKeys.some((k) => k.present),
      },
    ],
    keys: ghKeys,
    actions: [
      { id: 'install', label: 'Install gh', href: 'https://cli.github.com' },
      {
        id: 'token',
        label: 'Create a token',
        href: 'https://github.com/settings/personal-access-tokens/new',
      },
      { id: 'docs', label: 'GitHub loop', href: `${WIKI}/GitHub-loop` },
    ],
    brings: { connectors: ['github'], skills: [] },
  });

  const tg = present(c.env, 'SHIBAOX_TELEGRAM_TOKEN');
  rows.push({
    id: 'telegram',
    name: 'Telegram',
    description: 'Talk to the orchestrator and answer approvals from a Telegram bot.',
    checks: [{ label: 'Bot token (SHIBAOX_TELEGRAM_TOKEN)', ok: tg }],
    keys: [{ name: 'SHIBAOX_TELEGRAM_TOKEN', present: tg }],
    actions: [
      { id: 'botfather', label: 'Create a bot', href: 'https://t.me/BotFather' },
      { id: 'docs', label: 'Channels', href: `${WIKI}/Channels-and-Telegram` },
    ],
    brings: { connectors: [], skills: [] },
  });

  const ts = present(c.env, 'TYPESAFE_API_KEY');
  rows.push({
    id: 'typesafe',
    name: 'TypeSafe / Jev',
    description: 'Jev decides decide nodes and checks with typed answers and a confidence.',
    checks: [
      { label: 'API key (TYPESAFE_API_KEY)', ok: ts },
      {
        label: 'Jev decides',
        ok: decider?.kind === 'jev' && decider.usable,
        detail: decider
          ? `${decider.kind}${decider.ref ? ` · ${decider.ref}` : ''}${decider.reason ? ` · ${decider.reason}` : ''}`
          : 'unknown',
      },
    ],
    keys: [{ name: 'TYPESAFE_API_KEY', present: ts }],
    actions: [
      { id: 'docs', label: 'TypeSafe docs', href: 'https://docs.typesafe.ai/introduction' },
    ],
    brings: { connectors: [], skills: [] },
  });

  return rows.map((r) => ({ ...r, status: statusOf(r.checks) }));
}
