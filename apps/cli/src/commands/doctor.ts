import { runCommand } from '@shibaox/core';
import { DaemonClient, DaemonUnavailableError, homePaths, loadDaemonConfig } from '@shibaox/daemon';
import { CLI_VERSION } from '../version.js';

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

export async function doctorCommand(): Promise<number> {
  const lines: CheckLine[] = [];
  lines.push({ ...(await which('node')), required: true });
  lines.push({ ...(await which('git')), required: true });
  lines.push(await which('uv'));
  lines.push(await which('graphify'));
  lines.push(await which('claude'));
  lines.push(await which('codex'));
  lines.push(await which('cursor'));
  lines.push(await daemonLine());
  lines.push(await telegramLine());
  lines.push(await claudeAuthLine());
  // a Claude subscription (claude auth) replaces the API key; neither is needed for mock runs
  const claudeOk = lines.some((l) => l.name === 'claude auth' && l.ok);
  for (const env of ['ANTHROPIC_API_KEY', 'TYPESAFE_API_KEY']) {
    const set = Boolean(process.env[env]);
    lines.push({
      name: env,
      ok: set,
      detail: set
        ? 'set'
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
  const token = process.env[tg.bot_token_env];
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
