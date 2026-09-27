import { execFile } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryEventStore, type TaskJob } from '@shibaox/core';
import { Daemon, homePaths } from '@shibaox/daemon';
import { afterEach, describe, expect, it, vi } from 'vitest';

const sample = fileURLToPath(new URL('../../../examples/sample-repo', import.meta.url));
const bin = fileURLToPath(new URL('../dist/index.js', import.meta.url));

const tmpDirs: string[] = [];
const daemons: Daemon[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop({ force: true }).catch(() => undefined);
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

async function setup(extra: ConstructorParameters<typeof Daemon>[0] = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cli-d-'));
  tmpDirs.push(dir);
  const home = extra.home ?? homePaths({ SHIBAOX_HOME: join(dir, 'home') });
  const project = join(dir, 'proj');
  cpSync(sample, project, { recursive: true });
  const daemon = new Daemon({
    home,
    store: new MemoryEventStore(),
    channels: [],
    env: {},
    log: () => {},
    version: '0.0.1',
    ...extra,
  });
  daemons.push(daemon);
  await daemon.start();
  const cli = (...args: string[]) =>
    new Promise<Result>((resolve) => {
      execFile(
        process.execPath,
        [bin, ...args],
        {
          // never auto-start a real daemon from the tests: the in-process one must answer
          env: {
            PATH: process.env.PATH ?? '',
            SHIBAOX_HOME: home.root,
            HOME: dir,
            SHIBAOX_NO_AUTOSTART: '1',
          },
        },
        (err, stdout, stderr) =>
          resolve({
            code: (err as { code?: number } | null)?.code ?? 0,
            stdout: String(stdout),
            stderr: String(stderr),
          }),
      );
    });
  const init = await cli('init', dir);
  expect(init.code).toBe(0);
  return { dir, org: join(dir, 'org'), project, cli, daemon, home };
}

const lines = (s: string) => s.trim().split('\n').filter(Boolean);
const json = <T>(r: Result): T[] => lines(r.stdout).map((l) => JSON.parse(l) as T);

describe('shibaox CLI against a daemon', () => {
  it('run --detach, runs --json, inbox, approve and follow complete a mock run', async () => {
    const { org, project, cli } = await setup();
    const started = await cli(
      'run',
      'hello-feature',
      '--org',
      org,
      '--project',
      project,
      '--input',
      'add /health',
      '--adapter',
      'mock',
      '--workspace',
      'inplace',
      '--detach',
      '--json',
    );
    expect(started.code, started.stderr).toBe(0);
    const [{ runId }] = json<{ runId: string }>(started);
    expect(runId).toMatch(/[0-9a-f-]{36}/);
    await vi.waitFor(async () => {
      const inbox = json<{ id: string }>(await cli('inbox', '--json'));
      expect(inbox.map((i) => i.id)).toEqual([`human:${runId}:ship`]);
    });
    const runs = json<{ runId: string; status: string }>(await cli('runs', '--json'));
    expect(runs).toMatchObject([{ runId, status: 'waiting_human' }]);
    const human = await cli('inbox');
    expect(human.stdout).toContain(`human:${runId}:ship`);
    expect(human.stdout).toContain('Approve the push?');
    const approved = await cli('approve', `human:${runId}:ship`, '--note', 'go');
    expect(approved.code).toBe(0);
    expect(approved.stdout).toContain('Approved');
    const followed = await cli('follow', runId);
    expect(followed.code, followed.stderr).toBe(0);
    expect(followed.stdout).toContain('RunCompleted');
    expect(followed.stdout).toContain('status=completed');
    const replay = await cli('replay', runId);
    expect(replay.stdout).toContain('HumanResponded');
  });

  it('run without --detach follows and exits 2 when the run fails', async () => {
    const { org, project, cli } = await setup({
      mockScript: (job: TaskJob) => {
        if (job.nodeId === 'implement') throw new Error('boom');
        return { output: {}, summary: 'ok' };
      },
    });
    const r = await cli(
      'run',
      'hello-feature',
      '--org',
      org,
      '--project',
      project,
      '--input',
      'x',
      '--adapter',
      'mock',
      '--workspace',
      'inplace',
    );
    expect(r.code).toBe(2);
    expect(r.stdout).toContain('NodeFailed implement');
    expect(r.stdout).toContain('status=failed');
  });

  it('deny cancels the run and a second answer is refused', async () => {
    const { org, project, cli } = await setup();
    const [{ runId }] = json<{ runId: string }>(
      await cli(
        'run',
        'hello-feature',
        '--org',
        org,
        '--project',
        project,
        '--input',
        'x',
        '--adapter',
        'mock',
        '--workspace',
        'inplace',
        '--detach',
        '--json',
      ),
    );
    await vi.waitFor(async () => expect((await cli('inbox', '--json')).stdout).toContain(runId));
    expect((await cli('deny', `human:${runId}:ship`)).stdout).toContain('Denied');
    const again = await cli('deny', `human:${runId}:ship`);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain('already answered');
    await vi.waitFor(async () =>
      expect((await cli('runs', '--json')).stdout).toContain('"cancelled"'),
    );
    const cancel = await cli('cancel', runId);
    expect(cancel.stdout).toContain('cancelled');
  });

  it('daemon status reports the version and an empty inbox prints a sentence', async () => {
    const { cli } = await setup();
    const status = await cli('daemon', 'status');
    expect(status.stdout).toContain('version 0.0.1');
    expect((await cli('inbox')).stdout).toContain('Nothing waiting for you.');
    const st = json<{ version: string }>(await cli('daemon', 'status', '--json'));
    expect(st[0]?.version).toBe('0.0.1');
  });

  it('tiers list/set change the org models without editing YAML', async () => {
    const { org, cli } = await setup();
    const list = await cli('tiers', '--org', org);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain('strong');
    expect(list.stdout).toContain('anthropic/claude-sonnet-5');
    const set = await cli('tiers', 'set', 'strong', 'openrouter/openai/gpt-5', '--org', org);
    expect(set.code).toBe(0);
    const again = await cli('tiers', '--org', org, '--json');
    const rows = again.stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { name: string; value?: string });
    expect(rows.find((r) => r.name === 'strong')?.value).toBe('openrouter/openai/gpt-5');
    const bad = await cli('tiers', 'set', 'judge', 'nope', '--org', org);
    expect(bad.code).not.toBe(0);
    // a budget typo or clearing a tier is refused, never silently applied
    expect((await cli('tiers', 'set', 'budget', '$10', '--org', org)).code).not.toBe(0);
    expect((await cli('tiers', 'set', 'budget', 'none', '--org', org)).code).not.toBe(0);
    expect((await cli('tiers', 'set', 'strong', 'none', '--org', org)).code).not.toBe(0);
    const after = json<{ name: string; value?: string }>(
      await cli('tiers', '--org', org, '--json'),
    );
    expect(after.find((r) => r.name === 'budget')?.value).toBe('5');
    expect(after.find((r) => r.name === 'strong')?.value).toBe('openrouter/openai/gpt-5');
  });

  it('run without --org uses the org under the shibaox home', async () => {
    const { project, cli, home } = await setup({ claudeInstalled: false });
    const r = await cli(
      'run',
      'chat',
      '--project',
      project,
      '--input',
      'olá',
      '--adapter',
      'mock',
      '--detach',
      '--json',
    );
    expect(r.code).toBe(0);
    const { runId } = JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}') as { runId: string };
    const shown = await cli('runs', '--json');
    const row = shown.stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { runId: string; orgRoot?: string })
      .find((x) => x.runId === runId);
    expect(row?.orgRoot).toBe(join(home.root, 'org'));
  });

  it('keys set/list/unset round-trip through the daemon', async () => {
    const { cli } = await setup();
    const set = await cli('keys', 'set', 'OPENROUTER_API_KEY', 'sk-or-1234567890');
    expect(set.code).toBe(0);
    expect(set.stdout).toContain('OPENROUTER_API_KEY');
    expect(set.stdout).not.toContain('1234567890');
    const list = await cli('keys', 'list');
    expect(list.stdout).toContain('OPENROUTER_API_KEY');
    expect(list.stdout).toContain('sk-o…7890');
    expect(list.stdout).toContain('TYPESAFE_API_KEY');
    const unset = await cli('keys', 'unset', 'OPENROUTER_API_KEY');
    expect(unset.code).toBe(0);
    const after = await cli('keys', 'list', '--json');
    const rows = after.stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { name: string; set: boolean });
    expect(rows.find((r) => r.name === 'OPENROUTER_API_KEY')?.set).toBe(false);
  });

  it('schedule add/list/rm round-trip', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-d-'));
    tmpDirs.push(dir);
    const { org, project, cli, home } = await setup({
      store: undefined,
      home: homePaths({ SHIBAOX_HOME: join(dir, 'home2') }),
    });
    expect(home.root).toBe(join(dir, 'home2'));
    const added = await cli(
      'schedule',
      'add',
      '0 9 * * 1-5',
      'hello-feature',
      '--org',
      org,
      '--project',
      project,
      '--input',
      'daily',
      '--json',
    );
    expect(added.code, added.stderr).toBe(0);
    const [row] = json<{ id: string; cron: string }>(added);
    expect(row?.cron).toBe('0 9 * * 1-5');
    expect((await cli('schedule', 'list')).stdout).toContain(row?.id ?? '');
    expect((await cli('schedule', 'rm', row?.id ?? '')).code).toBe(0);
    expect((await cli('schedule', 'list')).stdout).toContain('No schedules.');
  });

  it('the dashboard refuses without a TTY and points at runs', async () => {
    const { cli } = await setup();
    const bare = await cli();
    expect(bare.code).toBe(1);
    expect(bare.stderr).toContain('The dashboard needs an interactive terminal. Try: shibaox runs');
    const ui = await cli('ui');
    expect(ui.code).toBe(1);
    expect(ui.stderr).toContain('interactive terminal');
  });

  it('a missing daemon that cannot be started is a clear error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-d-'));
    tmpDirs.push(dir);
    const home = join(dir, 'home');
    const r = await new Promise<Result>((resolve) => {
      execFile(
        process.execPath,
        [bin, 'runs'],
        {
          env: {
            PATH: process.env.PATH ?? '',
            SHIBAOX_HOME: home,
            HOME: dir,
            SHIBAOX_NO_AUTOSTART: '1',
          },
        },
        (err, stdout, stderr) =>
          resolve({
            code: (err as { code?: number } | null)?.code ?? 0,
            stdout: String(stdout),
            stderr: String(stderr),
          }),
      );
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('No shibaox daemon is running');
  });
});
