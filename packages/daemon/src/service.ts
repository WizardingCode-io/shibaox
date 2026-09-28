import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { runArgv } from '@shibaox/core';
import type { HomePaths } from './home.js';

export const LAUNCHD_LABEL = 'io.shibaox.daemon';

type Exec = typeof runArgv;

export interface ServiceArgs {
  env?: NodeJS.ProcessEnv;
  exec?: Exec;
  uid?: number;
  /** Delay between polls/retries of launchctl (default 500 ms). */
  pollMs?: number;
}

/** `~/Library/LaunchAgents/io.shibaox.daemon.plist`. */
export function plistPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HOME || homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The launchd agent: the CLI's `daemon start` through a login shell, so the daemon inherits
 * the same environment as your terminal (provider keys, the Telegram token) without any
 * secret in the plist; restarted when it exits; output appended to `daemon.log`.
 */
export function renderPlist(o: { launcher: string; paths: HomePaths }): string {
  const command = `exec ${sh(o.launcher)}`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${LAUNCHD_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    '    <string>/bin/zsh</string>',
    '    <string>-lc</string>',
    `    <string>${xml(command)}</string>`,
    '  </array>',
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key><true/>',
    '  <key>ProcessType</key><string>Background</string>',
    `  <key>WorkingDirectory</key><string>${xml(o.paths.root)}</string>`,
    `  <key>StandardOutPath</key><string>${xml(o.paths.log)}</string>`,
    `  <key>StandardErrorPath</key><string>${xml(o.paths.log)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

const domain = (uid: number) => `gui/${uid}`;
const currentUid = () => userInfo().uid;

async function launchctl(exec: Exec, args: string[]) {
  return exec({ argv: ['launchctl', ...args], cwd: '/', timeoutMs: 20_000 });
}

/**
 * The launcher the service runs: the recorded node and CLI, but resolved again at launch when
 * either moved (a Node upgrade under nvm or brew), so the service never strands itself.
 */
export function renderLauncher(o: { node: string; cli: string; modules?: string }): string {
  const modules = o.modules ?? process.versions.modules;
  return [
    '#!/bin/sh',
    '# Written by `shibaox daemon install`; launchd runs it through a login shell.',
    `node=${sh(o.node)}`,
    `cli=${sh(o.cli)}`,
    `modules=${sh(modules)}`,
    'if [ ! -x "$node" ]; then',
    "  # the recorded node moved (an upgrade): the login shell's node may stand in, but only",
    '  # with the same ABI (native modules such as better-sqlite3 were built for it)',
    '  found="$(command -v node 2>/dev/null)"',
    '  if [ -n "$found" ] && [ "$("$found" -p process.versions.modules 2>/dev/null)" = "$modules" ]; then',
    '    node="$found"',
    '  else',
    '    echo "shibaox: the recorded node $node is gone and $found is not the same ABI: run shibaox daemon install" >&2',
    '    sleep 60',
    '    exit 1',
    '  fi',
    'fi',
    'if [ ! -f "$cli" ]; then',
    '  bin="$(command -v shibaox 2>/dev/null)"',
    '  if [ -n "$bin" ]; then echo "shibaox: the recorded CLI $cli is gone; using $bin" >&2; exec "$bin" daemon start; fi',
    '  echo "shibaox: the recorded CLI $cli is gone: run shibaox daemon install" >&2',
    '  sleep 60',
    '  exit 1',
    'fi',
    'exec "$node" "$cli" daemon start',
    '',
  ].join('\n');
}

/** An installed plist from before the launcher (absolute node path): one reinstall gets the launcher. */
export function servicePredatesLauncher(
  paths: HomePaths,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const file = plistPath(env);
  if (!existsSync(file)) return false;
  return !readFileSync(file, 'utf8').includes(paths.launcher);
}

/** The node and CLI the installed launcher records, and whether either is gone (reinstall). */
export function servicePaths(
  paths: HomePaths,
): { node: string; cli: string; stale: boolean } | undefined {
  if (!existsSync(paths.launcher)) return undefined;
  const text = readFileSync(paths.launcher, 'utf8');
  const node = /^node='((?:[^']|'\\'')*)'$/m.exec(text)?.[1]?.replace(/'\\''/g, "'");
  const cli = /^cli='((?:[^']|'\\'')*)'$/m.exec(text)?.[1]?.replace(/'\\''/g, "'");
  if (!node || !cli) return undefined;
  return { node, cli, stale: !existsSync(node) || !existsSync(cli) };
}

/** Writes the launcher and the plist and loads it (`bootstrap`, else `load -w`); an older copy is booted out first. */
export async function installService(
  o: ServiceArgs & { paths: HomePaths; node: string; cli: string },
): Promise<{ plist: string }> {
  const exec = o.exec ?? runArgv;
  const uid = o.uid ?? currentUid();
  const file = plistPath(o.env);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(o.paths.launcher, renderLauncher({ node: o.node, cli: o.cli }));
  chmodSync(o.paths.launcher, 0o755);
  writeFileSync(file, renderPlist({ launcher: o.paths.launcher, paths: o.paths }));
  const pollMs = o.pollMs ?? 500;
  const sleep = () => new Promise((r) => setTimeout(r, pollMs));
  // bootout returns before launchd finished tearing the old instance down: wait for the label
  // to disappear (up to ~5 s) before bootstrapping again
  await launchctl(exec, ['bootout', `${domain(uid)}/${LAUNCHD_LABEL}`]); // may fail: not loaded
  for (let i = 0; i < 10; i++) {
    const p = await launchctl(exec, ['print', `${domain(uid)}/${LAUNCHD_LABEL}`]);
    if (p.exitCode !== 0) break;
    await sleep();
  }
  let boot = await launchctl(exec, ['bootstrap', domain(uid), file]);
  for (let attempt = 1; boot.exitCode !== 0 && attempt < 4; attempt++) {
    await sleep();
    boot = await launchctl(exec, ['bootstrap', domain(uid), file]);
  }
  if (boot.exitCode !== 0) {
    const load = await launchctl(exec, ['load', '-w', file]);
    if (load.exitCode !== 0)
      throw new Error(
        `launchctl could not load the service: ${(boot.stderr || load.stderr).trim().slice(0, 300)}`,
      );
  }
  return { plist: file };
}

/** Boots the service out and removes the plist. */
export async function uninstallService(o: ServiceArgs & { paths: HomePaths }): Promise<void> {
  const exec = o.exec ?? runArgv;
  const uid = o.uid ?? currentUid();
  await launchctl(exec, ['bootout', `${domain(uid)}/${LAUNCHD_LABEL}`]);
  const file = plistPath(o.env);
  if (existsSync(file)) unlinkSync(file);
  if (existsSync(o.paths.launcher)) unlinkSync(o.paths.launcher);
}

export type ServiceStatus = 'installed' | 'not-loaded' | 'not-installed';

/** `installed` when the plist exists and launchd knows the label; `not-loaded` when only the file exists. */
export async function serviceStatus(o: ServiceArgs = {}): Promise<ServiceStatus> {
  if (!existsSync(plistPath(o.env))) return 'not-installed';
  const exec = o.exec ?? runArgv;
  const uid = o.uid ?? currentUid();
  const r = await launchctl(exec, ['print', `${domain(uid)}/${LAUNCHD_LABEL}`]);
  return r.exitCode === 0 ? 'installed' : 'not-loaded';
}
