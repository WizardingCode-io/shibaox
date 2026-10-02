import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runCommand } from '@wizardingcode/shibaox-core';
import {
  apiBase,
  DaemonClient,
  DaemonHttpError,
  DaemonUnavailableError,
  deciderInfo,
  defaultHiggsfieldProbe,
  HIGGSFIELD_API_KEYS_URL,
  type HiggsfieldMode,
  higgsfieldApiCheck,
  higgsfieldStatus,
  homePaths,
  loadDaemonConfig,
  registryFor,
  runtimeHiggsfieldMode,
  SecretsStore,
  serviceKind,
  serviceStatus,
} from '@wizardingcode/shibaox-daemon';
import { loadOrg } from '@wizardingcode/shibaox-schemas';
import { remoteTarget } from '../remote.js';
import { CLI_VERSION } from '../version.js';
import { staleServiceHint } from './daemon.js';

interface CheckLine {
  name: string;
  ok: boolean;
  detail: string;
  required: boolean;
}

async function which(bin: string, versionFlag = '--version'): Promise<CheckLine> {
  const r = await runCommand({
    command: `${bin} ${versionFlag}`,
    cwd: process.cwd(),
    timeoutMs: 10_000,
  });
  const ok = r.exitCode === 0;
  return {
    name: bin,
    ok,
    detail: ok ? (r.stdout.trim().split('\n')[0] ?? '') : 'not found',
    required: false,
  };
}

/** The running CLI file, symlinks (npm's bin) followed. */
export const realCli = (p: string): string => {
  try {
    return realpathSync(resolve(p));
  } catch {
    return resolve(p);
  }
};

/** Where this shibaox runs from: the installer's checkout (is its `bin` on the PATH?) or a development one. */
export function installLine(o: { root: string; env: NodeJS.ProcessEnv; cli?: string }): CheckLine {
  const app = realCli(o.env.SHIBAOX_APP || join(o.root, 'app'));
  const bin = join(o.root, 'bin');
  const cli = realCli(o.cli ?? process.argv[1] ?? '');
  if (/\/node_modules\/shibaox\//.test(cli))
    return {
      name: 'install',
      ok: true,
      detail: `installed from npm (${cli.replace(/\/dist\/.*$/, '')}); update with: npm i -g shibaox@latest`,
      required: false,
    };
  if (!cli.startsWith(`${app}/`)) {
    // apps/cli/dist/index.js → the checkout root, three levels up
    const checkout = resolve(cli, '..', '..', '..', '..');
    return {
      name: 'install',
      ok: true,
      detail: `a development checkout at ${checkout} (scripts/install.sh sets up ${app} + ${bin})`,
      required: false,
    };
  }
  const onPath = (o.env.PATH ?? '').split(':').includes(bin);
  return {
    name: 'install',
    ok: onPath,
    detail: onPath
      ? `${app} (shibaox upgrade updates it)`
      : `${bin} is not on the PATH: export PATH="${bin}:$PATH" (install.sh adds it to the shell profile)`,
    required: false,
  };
}

export async function doctorCommand(): Promise<number> {
  const lines: CheckLine[] = [];
  lines.push({ ...(await which('node')), required: true });
  lines.push(installLine({ root: homePaths().root, env: process.env }));
  lines.push({ ...(await which('git')), required: true });
  lines.push(await which('uv'));
  lines.push(await which('graphify'));
  const bun = await which('bun');
  lines.push({
    ...bun,
    detail: bun.ok
      ? `${bun.detail} (runs the dashboard)`
      : 'not found (the dashboard needs Bun: https://bun.sh)',
  });
  lines.push(await which('claude'));
  lines.push(await which('codex'));
  lines.push(await which('cursor'));
  lines.push(await daemonLine());
  const kind =
    process.env.SHIBAOX_CONTAINER || existsSync('/.dockerenv') ? undefined : serviceKind();
  if (kind) {
    const s = await serviceStatus();
    const hint = await staleServiceHint(homePaths());
    lines.push({
      name: 'service',
      ok: s === 'installed' && !hint,
      detail:
        s === 'installed' && hint
          ? hint.replace(/^service: /, '')
          : s === 'installed'
            ? `${kind} (starts at login)`
            : s === 'not-loaded'
              ? `${kind === 'systemd' ? 'unit present but not active' : 'plist present but not loaded'}: shibaox daemon install`
              : 'not installed (shibaox daemon install keeps the daemon running 24h)',
      required: false,
    });
  }
  lines.push(await telegramLine());
  lines.push(await claudeAuthLine());
  // a Claude subscription (claude auth) replaces the API key; neither is needed for mock runs
  const claudeOk = lines.some((l) => l.name === 'claude auth' && l.ok);
  const vault = new SecretsStore(homePaths().secrets);
  const withVault = vault.env(process.env);
  lines.push(decisionsLine(withVault));
  lines.push(await higgsfieldLine(withVault));
  lines.push(await higgsfieldApiLine(withVault));
  const stale = higgsfieldSkillLine(homePaths().org);
  if (stale) lines.push(stale);
  for (const env of ['ANTHROPIC_API_KEY', 'TYPESAFE_API_KEY', 'OPENROUTER_API_KEY']) {
    const set = Boolean(withVault[env]);
    lines.push({
      name: env,
      ok: set,
      detail: set
        ? vault.get(env)
          ? 'set (vault)'
          : 'set (shell env)'
        : env === 'ANTHROPIC_API_KEY' && claudeOk
          ? 'missing (fine: subscription roles use the claude login)'
          : 'missing',
      required: false,
    });
  }
  for (const l of lines)
    console.log(
      `${l.ok ? 'OK  ' : l.required ? 'FAIL' : 'warn'}  ${l.name.padEnd(20)} ${l.detail}`,
    );
  const failed = lines.some((l) => l.required && !l.ok);
  console.log(
    failed
      ? '\nFix the FAIL lines before running workflows.'
      : '\nReady. Runs go through the daemon (started on demand).',
  );
  return failed ? 1 : 0;
}

async function daemonLine(): Promise<CheckLine> {
  const paths = homePaths();
  const remote = remoteTarget(process.env);
  if (remote) {
    if (!remote.token)
      return {
        name: 'daemon',
        ok: false,
        detail: `remote ${remote.baseUrl}: no token (shibaox remote set ${remote.baseUrl} <token>, or SHIBAOX_REMOTE_TOKEN)`,
        required: false,
      };
    try {
      const h = await new DaemonClient({ baseUrl: remote.baseUrl, token: remote.token }).health();
      const older = h.version !== CLI_VERSION ? ` (this CLI is ${CLI_VERSION})` : '';
      return {
        name: 'daemon',
        ok: true,
        detail: `remote ${remote.baseUrl}, version ${h.version}${older}`,
        required: false,
      };
    } catch (e) {
      const detail =
        e instanceof DaemonUnavailableError
          ? `no answer at ${remote.baseUrl} (is shibaox serve running there?)`
          : e instanceof DaemonHttpError && e.status === 401
            ? `${remote.baseUrl} refused the token: shibaox remote set ${remote.baseUrl} <token>`
            : String(e);
      return { name: 'daemon', ok: false, detail, required: false };
    }
  }
  try {
    const h = await new DaemonClient(paths.socket).health();
    const stale = h.version !== CLI_VERSION ? ` (CLI is ${CLI_VERSION}: restart it)` : '';
    return {
      name: 'daemon',
      ok: true,
      detail: `running, version ${h.version}${stale}`,
      required: false,
    };
  } catch (e) {
    const detail =
      e instanceof DaemonUnavailableError ? 'not running (starts on demand)' : String(e);
    return { name: 'daemon', ok: false, detail, required: false };
  }
}

async function telegramLine(): Promise<CheckLine> {
  const paths = homePaths();
  let tg: { bot_token_env: string; chat_id: number } | undefined;
  try {
    tg = loadDaemonConfig(paths.config).channels.telegram;
  } catch (e) {
    return {
      name: 'telegram',
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
      required: false,
    };
  }
  if (!tg)
    return {
      name: 'telegram',
      ok: false,
      detail: 'not configured (daemon.yaml channels.telegram)',
      required: false,
    };
  const token = new SecretsStore(paths.secrets).env(process.env)[tg.bot_token_env];
  if (!token)
    return { name: 'telegram', ok: false, detail: `${tg.bot_token_env} not set`, required: false };
  // the daemon read the env when it started: a token exported later is not there yet
  const running = await new DaemonClient(paths.socket).health().catch(() => undefined);
  if (running && !running.channels.includes('telegram'))
    return {
      name: 'telegram',
      ok: false,
      detail:
        'configured here, but the running daemon started without the token: restart it (shibaox daemon stop && shibaox daemon start --detach)',
      required: false,
    };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const json = (await res.json()) as { ok?: boolean; result?: { username?: string } };
    return json.ok
      ? {
          name: 'telegram',
          ok: true,
          detail: `bot @${json.result?.username ?? '?'}, chat ${tg.chat_id}`,
          required: false,
        }
      : { name: 'telegram', ok: false, detail: 'getMe failed: check the token', required: false };
  } catch (e) {
    return {
      name: 'telegram',
      ok: false,
      detail: `getMe failed: ${e instanceof Error ? e.message : String(e)}`,
      required: false,
    };
  }
}

async function claudeAuthLine(): Promise<CheckLine> {
  const r = await runCommand({
    command: 'claude auth status',
    cwd: process.cwd(),
    timeoutMs: 15_000,
  });
  if (r.exitCode !== 0)
    return {
      name: 'claude auth',
      ok: false,
      detail: 'not logged in or claude not found (run: claude)',
      required: false,
    };
  // `claude auth status` prints JSON; summarise it in one line
  try {
    const j = JSON.parse(r.stdout) as { loggedIn?: boolean; authMethod?: string; email?: string };
    if (j.loggedIn === false)
      return {
        name: 'claude auth',
        ok: false,
        detail: 'not logged in (run: claude)',
        required: false,
      };
    const who = [j.authMethod, j.email].filter(Boolean).join(', ');
    return {
      name: 'claude auth',
      ok: true,
      detail: `logged in${who ? ` (${who})` : ''}`,
      required: false,
    };
  } catch {
    return {
      name: 'claude auth',
      ok: true,
      detail: r.stdout.trim().split('\n')[0] ?? 'logged in',
      required: false,
    };
  }
}

/** Who decides for the home org (`tiers.decision`), and whether that model or key is usable. */
function decisionsLine(env: NodeJS.ProcessEnv): CheckLine {
  const paths = homePaths();
  if (!existsSync(join(paths.org, 'org.yaml')))
    return {
      name: 'decisions',
      ok: false,
      required: false,
      detail: 'no home org yet (shibaox init)',
    };
  try {
    const info = deciderInfo(loadOrg(paths.org), env, registryFor(env));
    const what =
      info.kind === 'jev' ? `Jev (TypeSafe), ${info.ref}` : (info.ref ?? 'no decision tier');
    return {
      name: 'decisions',
      ok: info.usable,
      required: false,
      detail: info.usable
        ? `${what} (usable)${info.reason ? `: ${info.reason}` : ''}`
        : `${what}: ${info.reason ?? 'not usable'}`,
    };
  } catch (e) {
    return {
      name: 'decisions',
      ok: false,
      required: false,
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Higgsfield: the CLI, who is logged in, the credits (images and video need it). */
async function higgsfieldLine(env: NodeJS.ProcessEnv): Promise<CheckLine> {
  const v = await higgsfieldStatus(defaultHiggsfieldProbe(env), { signupUrl: '' });
  if (!v.cli.installed)
    return {
      name: 'higgsfield',
      ok: false,
      required: false,
      detail: `not installed (images and video): ${v.installCommand}`,
    };
  if (!v.loggedIn)
    return {
      name: 'higgsfield',
      ok: false,
      required: false,
      detail: `${v.cli.version ?? 'installed'}, not logged in (run: higgsfield auth login)`,
    };
  return {
    name: 'higgsfield',
    ok: true,
    required: false,
    detail: `${v.cli.version ?? ''} · ${v.account?.email} (${v.account?.plan}), ${v.account?.credits} credits · MCP ${v.mcp}`,
  };
}

/** Higgsfield's API path: whether a key is saved and accepted, and the mode it gives. */
async function higgsfieldApiLine(env: NodeJS.ProcessEnv): Promise<CheckLine> {
  let mode: HiggsfieldMode = 'auto';
  try {
    mode = loadDaemonConfig(homePaths().config).partners.higgsfield.mode;
  } catch {
    // an unreadable daemon.yaml has its own line
  }
  const key = env.HIGGSFIELD_API_KEY;
  const line = (ok: boolean, detail: string): CheckLine => ({
    name: 'higgsfield api',
    ok,
    required: false,
    detail,
  });
  if (!key) return line(false, `no key (optional: ${HIGGSFIELD_API_KEYS_URL}) · mode ${mode}`);
  // the base from the shell this command runs in, never the vault
  const r = await higgsfieldApiCheck(key, apiBase(process.env));
  const now = `mode ${mode} → ${runtimeHiggsfieldMode(mode, true)}`;
  if (r.valid === true) return line(true, `key set, valid · ${now}`);
  if (r.valid === false) return line(false, `key set, rejected (${r.status ?? 401}) · ${now}`);
  return line(
    false,
    `key set, not checked (${r.status ? `HTTP ${r.status}` : 'no answer'}) · ${now}`,
  );
}

/** The home org's higgsfield skill from before the API mode (it does not know the API tools). */
function higgsfieldSkillLine(org: string): CheckLine | undefined {
  const file = join(org, 'skills', 'higgsfield', 'SKILL.md');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  if (text.includes('higgsfield_api_')) return undefined;
  return {
    name: 'higgsfield skill',
    ok: false,
    required: false,
    detail: `${file} predates the API mode: shibaox skills add higgsfield --builtin --replace`,
  };
}
