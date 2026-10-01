import { spawn } from 'node:child_process';
import { bearerEnv, runArgv } from '@wizardingcode/shibaox-core';

export const HIGGSFIELD_INSTALL =
  'curl -fsSL https://raw.githubusercontent.com/higgsfield-ai/cli/main/install.sh | sh';
export const HIGGSFIELD_MCP = 'https://mcp.higgsfield.ai/mcp';

export interface HiggsfieldView {
  cli: { installed: boolean; version?: string };
  loggedIn: boolean;
  account?: { email: string; plan: string; credits: number };
  /** Whether Higgsfield's MCP answers the CLI's token. */
  mcp: 'ok' | 'unauthorized' | 'unreachable';
  signupUrl: string;
  installCommand: string;
  site: string;
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
}

export function defaultHiggsfieldProbe(env: NodeJS.ProcessEnv): HiggsfieldProbe {
  // the CLI runs with a minimal environment: never the daemon's keys
  const minimal = bearerEnv(env);
  return {
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
): Promise<HiggsfieldView> {
  const base: HiggsfieldView = {
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
  const view: HiggsfieldView = {
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
