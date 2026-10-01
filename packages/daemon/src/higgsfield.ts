import { spawn } from 'node:child_process';
import { augmentPath, runArgv } from '@wizardingcode/shibaox-core';

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
export interface HiggsfieldProbe {
  exec(argv: string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
  mcp(token: string): Promise<'ok' | 'unauthorized' | 'unreachable'>;
  /** Starts the browser login on this machine, detached (default: spawn). */
  login?(): void;
}

export function defaultHiggsfieldProbe(env: NodeJS.ProcessEnv): HiggsfieldProbe {
  const PATH = augmentPath(env.PATH, env.HOME);
  return {
    exec: (argv) => runArgv({ argv, cwd: env.HOME ?? '/', timeoutMs: 15_000, env: { PATH } }),
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
    login: () => {
      const child = spawn('higgsfield', ['auth', 'login'], {
        detached: true,
        stdio: 'ignore',
        env: { ...env, PATH },
      });
      child.unref();
    },
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
