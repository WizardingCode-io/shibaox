import { spawn } from 'node:child_process';
import { bearerEnv, runArgv } from '@wizardingcode/shibaox-core';
import type { HiggsfieldMode } from './config.js';

export const HIGGSFIELD_INSTALL =
  'curl -fsSL https://raw.githubusercontent.com/higgsfield-ai/cli/main/install.sh | sh';
export const HIGGSFIELD_MCP = 'https://mcp.higgsfield.ai/mcp';
/** Higgsfield's REST API for developers (a key from open.higgsfield.ai). */
export const HIGGSFIELD_API = 'https://api.higgsfield.ai';
export const HIGGSFIELD_API_KEYS_URL = 'https://open.higgsfield.ai/api-keys';
export const HIGGSFIELD_API_DOCS = 'https://docs.higgsfield.ai/docs';
/** A request id that never exists: its status answers 404 to a valid key and 401 to a bad one. */
export const PROBE_REQUEST_ID = '00000000-0000-0000-0000-000000000000';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * The API base: `SHIBAOX_HIGGSFIELD_API_BASE` from the environment the daemon or CLI was
 * launched with (never the vault: callers pass the launch env), https only, or http on a
 * loopback host. Anything else is ignored (with `warn`) and the public API is used.
 */
export function apiBase(launchEnv: NodeJS.ProcessEnv, warn?: (line: string) => void): string {
  const b = launchEnv.SHIBAOX_HIGGSFIELD_API_BASE?.trim();
  if (!b) return HIGGSFIELD_API;
  let u: URL | undefined;
  try {
    u = new URL(b);
  } catch {
    u = undefined;
  }
  if (u && (u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname))))
    return b.replace(/\/+$/, '');
  warn?.(
    `warn: SHIBAOX_HIGGSFIELD_API_BASE is ignored: it must be an https URL (http only on 127.0.0.1, localhost or [::1]); using ${HIGGSFIELD_API}`,
  );
  return HIGGSFIELD_API;
}

/** What the probe's HTTP status says about the key. */
export function apiValidity(status: number): boolean | 'unknown' {
  if (status === 401 || status === 403) return false;
  if (status === 404) return true;
  return 'unknown';
}

/** What generates now: the configured mode against what is set up. */
export function effectiveHiggsfieldMode(
  mode: HiggsfieldMode,
  s: { keySet: boolean; loggedIn: boolean },
): 'account' | 'api' | 'none' {
  if (mode === 'api') return s.keySet ? 'api' : 'none';
  if (mode === 'account') return s.loggedIn ? 'account' : 'none';
  return s.keySet ? 'api' : s.loggedIn ? 'account' : 'none';
}

/** The path a task is given: `auto` is the API when a key is saved, else the account. */
export function runtimeHiggsfieldMode(mode: HiggsfieldMode, keySet: boolean): 'account' | 'api' {
  if (mode === 'auto') return keySet ? 'api' : 'account';
  return mode;
}

/** The key probe's answer: `valid` is absent when the answer says nothing (5xx, no network). */
export interface ApiCheck {
  valid?: boolean;
  status?: number;
}

/** GET the zero request's status with the key: 404 accepted, 401/403 refused. Never throws. */
export async function higgsfieldApiCheck(key: string, base: string): Promise<ApiCheck> {
  try {
    const r = await fetch(`${base}/requests/${PROBE_REQUEST_ID}/status`, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Key ${key}`, accept: 'application/json' },
    });
    await r.body?.cancel().catch(() => undefined);
    const v = apiValidity(r.status);
    return v === 'unknown' ? { status: r.status } : { valid: v, status: r.status };
  } catch {
    return {};
  }
}

/** The account path: the CLI, the login, the MCP. */
export interface HiggsfieldAccountView {
  cli: { installed: boolean; version?: string };
  loggedIn: boolean;
  account?: { email: string; plan: string; credits: number };
  /** Whether Higgsfield's MCP answers the CLI's token. */
  mcp: 'ok' | 'unauthorized' | 'unreachable';
  signupUrl: string;
  installCommand: string;
  site: string;
}

/** The API path: whether a key is saved and what Higgsfield said about it (never the key). */
export interface HiggsfieldApiView {
  keySet: boolean;
  /** Absent: not checked, or the answer said nothing. */
  valid?: boolean;
  /** The probe's HTTP status. */
  status?: number;
  /** When the probe ran (ISO). */
  checkedAt?: string;
}

export interface HiggsfieldView extends HiggsfieldAccountView {
  api: HiggsfieldApiView;
  /** `partners.higgsfield.mode` in daemon.yaml. */
  mode: HiggsfieldMode;
  /** What generates now. */
  effective: 'account' | 'api' | 'none';
}

/** How the daemon talks to the Higgsfield CLI and MCP (tests inject fakes). */
export interface LoginStart {
  started: boolean;
  /** A URL or device code the CLI printed (headless machines: open it anywhere). */
  url?: string;
  output?: string;
}
export interface HiggsfieldProbe {
  exec(argv: string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
  mcp(token: string): Promise<'ok' | 'unauthorized' | 'unreachable'>;
  /** Starts the browser login on this machine and reports what the CLI printed in its first seconds. */
  login(): Promise<LoginStart>;
  /** Asks the API whether `key` is accepted (absent: the API is never probed). */
  apiCheck?(key: string): Promise<ApiCheck>;
}

/** `base`: the API base from the launch env (`apiBase`), never read from `env` (it has the vault). */
export function defaultHiggsfieldProbe(
  env: NodeJS.ProcessEnv,
  base: string = HIGGSFIELD_API,
): HiggsfieldProbe {
  // the CLI runs with a minimal environment: never the daemon's keys
  const minimal = bearerEnv(env);
  return {
    apiCheck: (key) => higgsfieldApiCheck(key, base),
    exec: (argv) =>
      runArgv({ argv, cwd: env.HOME ?? '/', timeoutMs: 5_000, inheritEnv: false, env: minimal }),
    mcp: async (token) => {
      try {
        const r = await fetch(HIGGSFIELD_MCP, {
          method: 'POST',
          signal: AbortSignal.timeout(10_000),
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2025-06-18',
              capabilities: {},
              clientInfo: { name: 'shibaox', version: '0' },
            },
          }),
        });
        await r.body?.cancel().catch(() => undefined);
        return r.ok ? 'ok' : r.status === 401 || r.status === 403 ? 'unauthorized' : 'unreachable';
      } catch {
        return 'unreachable';
      }
    },
    login: () =>
      new Promise<LoginStart>((resolve) => {
        let out = '';
        let child: ReturnType<typeof spawn>;
        try {
          child = spawn('higgsfield', ['auth', 'login'], {
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: minimal,
          });
        } catch (e) {
          resolve({ started: false, output: e instanceof Error ? e.message : String(e) });
          return;
        }
        const done = (started: boolean) => {
          const url = /https?:\/\/\S+/.exec(out)?.[0];
          resolve({
            started,
            ...(url ? { url } : {}),
            ...(out.trim() ? { output: out.trim().slice(0, 2000) } : {}),
          });
        };
        child.on('error', () => done(false));
        child.stdout?.on('data', (d: Buffer) => {
          out += d.toString();
        });
        child.stderr?.on('data', (d: Buffer) => {
          out += d.toString();
        });
        // the login goes on in the browser; what the CLI printed in its first seconds is enough
        setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.unref();
          done(true);
        }, 4_000);
      }),
  };
}

/** The Higgsfield status for Integrations and the doctor: the CLI, the account, the MCP. */
export async function higgsfieldStatus(
  probe: HiggsfieldProbe,
  o: { signupUrl: string },
): Promise<HiggsfieldAccountView> {
  const base: HiggsfieldAccountView = {
    cli: { installed: false },
    loggedIn: false,
    mcp: 'unreachable',
    signupUrl: o.signupUrl,
    installCommand: HIGGSFIELD_INSTALL,
    site: 'https://higgsfield.ai',
  };
  const v = await probe.exec(['higgsfield', 'version']).catch(() => undefined);
  if (!v || v.exitCode !== 0) return base;
  const version = /higgsfield\s+v?([\d.]+)/.exec(v.stdout)?.[1];
  const view: HiggsfieldAccountView = {
    ...base,
    cli: { installed: true, ...(version ? { version } : {}) },
  };
  const a = await probe.exec(['higgsfield', 'account', 'status', '--json']).catch(() => undefined);
  if (a && a.exitCode === 0) {
    try {
      const j = JSON.parse(a.stdout) as {
        email?: string;
        subscription_plan_type?: string;
        credits?: number;
      };
      if (j.email) {
        view.loggedIn = true;
        view.account = {
          email: j.email,
          plan: j.subscription_plan_type ?? '',
          credits: Number(j.credits ?? 0),
        };
      }
    } catch {
      // not JSON: not logged in
    }
  }
  if (view.loggedIn) {
    const t = await probe.exec(['higgsfield', 'auth', 'token']).catch(() => undefined);
    const token = t?.stdout.trim().split('\n').pop()?.trim();
    view.mcp = t?.exitCode === 0 && token ? await probe.mcp(token) : 'unauthorized';
  }
  return view;
}
