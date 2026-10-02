import { accessSync, constants, statSync } from 'node:fs';
import { join } from 'node:path';
import { augmentPath } from '@wizardingcode/shibaox-core';
import type { HiggsfieldMode } from './config.js';
import { HIGGSFIELD_API_DOCS, HIGGSFIELD_API_KEYS_URL, type HiggsfieldView } from './higgsfield.js';
import type { DeciderInfo } from './runtime.js';

/** What a plugin (or one of its modes) adds to an org: connectors, skills, daemon tools. */
export interface Brings {
  connectors: string[];
  skills: string[];
  /** Tools the daemon itself gives a role in this mode (no connector needed). */
  tools?: string[];
  /** Skills shipped with Shibaox (`POST /skills {source:'builtin', id}`). */
  builtin?: string[];
}

type Check = { label: string; ok: boolean; detail?: string };
type Action = { id: string; label: string; href?: string; command?: string };

/** One way of using a plugin (Higgsfield: the account, or an API key), with its own setup. */
export interface PluginMode {
  id: 'account' | 'api';
  name: string;
  description: string;
  /** The mode the row's top level shows (the one generating, or the one chosen). */
  active: boolean;
  status: 'ready' | 'partial' | 'off';
  checks: Check[];
  keys: { name: string; present: boolean }[];
  actions: Action[];
  brings: Brings;
}

/** A partner integration with its own setup (a CLI, an account, keys), and what it brings. */
export interface PluginRow {
  id: string;
  name: string;
  description: string;
  /** `ready`: every check passes; `partial`: some do; `off`: none. */
  status: 'ready' | 'partial' | 'off';
  checks: Check[];
  keys: { name: string; present: boolean }[];
  /** `href` opens (an absolute URL) or is POSTed (a daemon path); `command` is copied. */
  actions: Action[];
  brings: Brings;
  /** Plugins usable in more than one way; the top level repeats the active mode. */
  modes?: PluginMode[];
  /** The chosen mode (daemon.yaml) and what generates now. */
  mode?: { configured: HiggsfieldMode; effective: 'account' | 'api' | 'none' };
}

/** The daemon tools a role gets in Higgsfield's API mode. */
export const HIGGSFIELD_API_TOOLS = [
  'higgsfield_api_generate',
  'higgsfield_api_status',
  'higgsfield_api_cancel',
  'higgsfield_api_upload',
];

/** What the plugin status is made of (tests inject fakes; the daemon passes its probes). */
export interface PluginChecks {
  higgsfield(): Promise<HiggsfieldView>;
  /** The path of an executable on the (augmented) PATH, or undefined. */
  which(cmd: string): Promise<string | undefined>;
  /** The daemon's environment with the vault on top (only presence is read). */
  env: NodeJS.ProcessEnv;
  decider(): Promise<DeciderInfo | undefined>;
  /** Jev routing of the home org's chat turns, and the newest route. */
  routing?(): Promise<PluginRouting | undefined>;
  /** Telegram: a chat paired in daemon.yaml (`channels.telegram.chat_id`), the channel running. */
  telegram(): { paired: boolean; chatId?: number; running: boolean };
}

/** Whether Jev routes chat turns (see `routingInfo`) and the newest `router` decision. */
export interface PluginRouting {
  on: boolean;
  reason?: string;
  last?: { intent: string; confidence?: number };
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
  const [hf, gh, decider, routing] = await Promise.all([
    safe(c.higgsfield),
    safe(() => c.which('gh')),
    safe(c.decider),
    safe(async () => c.routing?.()),
  ]);
  const rows: Omit<PluginRow, 'status'>[] = [];

  rows.push(higgsfieldRow(hf, present(c.env, 'HIGGSFIELD_API_KEY')));

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
  const tgState = (() => {
    try {
      return c.telegram();
    } catch {
      return { paired: false, running: false };
    }
  })();
  rows.push({
    id: 'telegram',
    name: 'Telegram',
    description: 'Talk to the orchestrator and answer approvals from a Telegram bot.',
    checks: [
      { label: 'Bot token (SHIBAOX_TELEGRAM_TOKEN)', ok: tg },
      {
        label: 'Paired with a chat',
        ok: tgState.paired,
        ...(tgState.paired && tgState.chatId !== undefined
          ? { detail: `chat ${tgState.chatId}` }
          : {}),
      },
      { label: 'Channel running', ok: tgState.running },
    ],
    keys: [{ name: 'SHIBAOX_TELEGRAM_TOKEN', present: tg }],
    actions: [
      // POSTed by the app to /plugins/telegram/actions/<id>
      { id: 'pair', label: 'Pair with my Telegram' },
      { id: 'test', label: 'Send a test message' },
      { id: 'botfather', label: 'Create a bot', href: 'https://t.me/BotFather' },
      { id: 'docs', label: 'Channels', href: `${WIKI}/Channels-and-Telegram` },
    ],
    brings: { connectors: [], skills: [], tools: ['telegram_send'] },
  });

  rows.push(typesafeRow(present(c.env, 'TYPESAFE_API_KEY'), decider, routing));

  return rows.map((r) => ({ ...r, status: statusOf(r.checks) }));
}

/**
 * TypeSafe / Jev: the key, who decides, whether Jev routes chat turns, whether Jev runs the
 * `jev` checks (its check runner is on exactly when Jev decides: the key and jev-latest).
 */
function typesafeRow(
  key: boolean,
  decider: DeciderInfo | undefined,
  routing: PluginRouting | undefined,
): Omit<PluginRow, 'status'> {
  const decides = decider?.kind === 'jev' && decider.usable;
  const decidesDetail = !decider
    ? 'unknown'
    : decides
      ? (decider.ref ?? 'jev-latest')
      : decider.kind === 'model'
        ? `the decision tier is ${decider.ref}: an LLM decides`
        : (decider.reason ?? 'nobody decides');
  const routes = routing?.on === true;
  const last = routing?.last;
  const routesDetail =
    routes && last
      ? `last: ${last.intent}${last.confidence !== undefined ? ` ${last.confidence.toFixed(2)}` : ''}`
      : routes
        ? undefined
        : (routing?.reason ?? 'off');
  return {
    id: 'typesafe',
    name: 'TypeSafe / Jev',
    description:
      'Jev decides decide nodes, routes every chat turn and runs checks, with typed answers and a confidence.',
    checks: [
      { label: 'API key (TYPESAFE_API_KEY)', ok: key },
      { label: 'Jev decides', ok: decides, detail: decidesDetail },
      {
        label: 'Jev routes requests',
        ok: routes,
        ...(routesDetail ? { detail: routesDetail } : {}),
      },
      {
        label: 'Jev runs checks',
        ok: key && decides,
        ...(key && decides ? {} : { detail: 'with the key and jev-latest as the decision tier' }),
      },
    ],
    keys: [{ name: 'TYPESAFE_API_KEY', present: key }],
    actions: [
      // POSTed by the app to /plugins/typesafe/actions/<id> (they write the home org)
      ...(decides ? [] : [{ id: 'use_jev', label: 'Use Jev for decisions' }]),
      routes
        ? { id: 'routing_off', label: 'Stop routing requests' }
        : { id: 'routing_on', label: 'Route requests with Jev' },
      { id: 'docs', label: 'TypeSafe docs', href: 'https://docs.typesafe.ai' },
    ],
    brings: { connectors: [], skills: ['typesafe-ai'], tools: [] },
  };
}

/** Higgsfield's two modes; the top level is the active one. */
function higgsfieldRow(
  hf: HiggsfieldView | undefined,
  keyPresent: boolean,
): Omit<PluginRow, 'status'> {
  const accountChecks: Check[] = [
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
  ];
  const api = hf?.api ?? { keySet: false };
  const apiChecks: Check[] = [
    { label: 'API key saved', ok: api.keySet },
    {
      label: 'API key valid',
      ok: api.keySet && api.valid === true,
      detail: !api.keySet
        ? 'no key'
        : api.valid === true
          ? 'accepted'
          : api.valid === false
            ? `rejected by Higgsfield (${api.status ?? 401})`
            : 'not checked',
    },
  ];
  const configured: HiggsfieldMode = hf?.mode ?? 'auto';
  const effective = hf?.effective ?? 'none';
  const activeId: PluginMode['id'] =
    effective === 'api'
      ? 'api'
      : effective === 'account'
        ? 'account'
        : configured === 'api'
          ? 'api'
          : 'account';
  const modes: PluginMode[] = [
    {
      id: 'account',
      name: 'Account',
      description:
        "Log in with the Higgsfield CLI: generations use your plan credits through Higgsfield's MCP.",
      active: activeId === 'account',
      status: statusOf(accountChecks),
      checks: accountChecks,
      keys: [],
      actions: [
        { id: 'install', label: 'Install command', ...(hf ? { command: hf.installCommand } : {}) },
        { id: 'login', label: 'Log in', href: '/integrations/higgsfield/login' },
        { id: 'signup', label: 'Create account', ...(hf ? { href: hf.signupUrl } : {}) },
        { id: 'open', label: 'Open Higgsfield', href: hf?.site ?? 'https://higgsfield.ai' },
      ],
      brings: { connectors: ['higgsfield'], skills: ['higgsfield'], builtin: ['higgsfield'] },
    },
    {
      id: 'api',
      name: 'API',
      description:
        'A developer key from open.higgsfield.ai: the daemon calls the REST API, billed to your developer account; build apps on it too.',
      active: activeId === 'api',
      status: statusOf(apiChecks),
      checks: apiChecks,
      keys: [{ name: 'HIGGSFIELD_API_KEY', present: keyPresent }],
      actions: [
        {
          id: 'connect_key',
          label: api.keySet ? 'Manage API key' : 'Connect API key',
          href: HIGGSFIELD_API_KEYS_URL,
        },
        { id: 'docs', label: 'API docs', href: HIGGSFIELD_API_DOCS },
      ],
      brings: {
        connectors: [],
        skills: ['higgsfield', 'higgsfield-app'],
        builtin: ['higgsfield', 'higgsfield-app'],
        tools: [...HIGGSFIELD_API_TOOLS],
      },
    },
  ];
  const top = modes.find((m) => m.active) as PluginMode;
  return {
    id: 'higgsfield',
    name: 'Higgsfield',
    description:
      'Images, video, audio and 3D from 40+ models: on your Higgsfield account, or with an API key.',
    checks: top.checks,
    keys: top.keys,
    actions: top.actions,
    brings: top.brings,
    modes,
    mode: { configured, effective },
  };
}
