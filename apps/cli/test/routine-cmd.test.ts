import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Daemon, homePaths, scaffoldOrg } from '@wizardingcode/shibaox-daemon';
import { SqliteEventStore } from '@wizardingcode/shibaox-persistence-sqlite';
import { afterEach, describe, expect, it } from 'vitest';

const bin = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const tmp: string[] = [];
const daemons: Daemon[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop({ force: true }).catch(() => undefined);
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});
const cli = (env: Record<string, string>, ...args: string[]) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      [bin, ...args],
      { env: { PATH: process.env.PATH ?? '', SHIBAOX_NO_AUTOSTART: '1', ...env } },
      (err, stdout, stderr) =>
        resolve({
          code: (err as { code?: number } | null)?.code ?? 0,
          stdout: String(stdout),
          stderr: String(stderr),
        }),
    );
  });

describe('shibaox routine: manual, model, approvals, update, show', () => {
  it('adds a manual routine with a model and a policy, updates it, and shows when it runs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-routine-'));
    tmp.push(dir);
    scaffoldOrg(dir);
    const home = homePaths({ SHIBAOX_HOME: join(dir, 'home') });
    const daemon = new Daemon({
      discovery: false,
      home,
      store: new SqliteEventStore(join(dir, 'home', 'events.db')),
      channels: [],
      env: {},
      log: () => {},
      version: '0.2.7',
    });
    daemons.push(daemon);
    await daemon.start();
    const env = { SHIBAOX_HOME: home.root, HOME: dir };
    const added = await cli(
      env,
      'routine',
      'add',
      'chat',
      '--on',
      'manual',
      '--org',
      join(dir, 'org'),
      '--project',
      dir,
      '--input',
      'report',
      '--name',
      'Report',
      '--model',
      'openai/gpt-5',
      '--approvals',
      'auto',
      '--json',
    );
    expect(added.code).toBe(0);
    const row = JSON.parse(added.stdout.trim().split('\n').pop() ?? '{}');
    expect(row).toMatchObject({
      trigger: { type: 'manual' },
      model: 'openai/gpt-5',
      approvals: 'auto',
    });
    const bad = await cli(
      env,
      'routine',
      'add',
      'chat',
      '--on',
      'manual',
      '--org',
      join(dir, 'org'),
      '--project',
      dir,
      '--approvals',
      'maybe',
    );
    expect(bad.code).not.toBe(0);
    expect(bad.stdout + bad.stderr).toMatch(/inbox, auto or skip/);
    const updated = await cli(
      env,
      'routine',
      'update',
      row.id,
      '--on',
      'cron:0 9 * * 1-5',
      '--approvals',
      'inbox',
      '--json',
    );
    expect(updated.code).toBe(0);
    expect(JSON.parse(updated.stdout.trim().split('\n').pop() ?? '{}')).toMatchObject({
      trigger: { type: 'cron', cron: '0 9 * * 1-5' },
      approvals: 'inbox',
      model: 'openai/gpt-5',
    });
    const shown = await cli(env, 'routine', 'show', row.id);
    expect(shown.stdout).toContain('when: Weekdays at 09:00 · next 20');
    expect(shown.stdout).toContain('model openai/gpt-5');
    const nothing = await cli(env, 'routine', 'update', row.id);
    expect(nothing.code).toBe(1);
    // back to manual: no watcher interval or mode on a routine that only runs by hand
    await cli(env, 'routine', 'update', row.id, '--on', 'manual');
    const manual = await cli(env, 'routine', 'show', row.id);
    expect(manual.stdout).toContain('trigger: manual\n');
    expect(manual.stdout).not.toContain('every ');
  });
});
