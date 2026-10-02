import { execFile, execFileSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryEventStore, type TaskJob } from '@wizardingcode/shibaox-core';
import { Daemon, homePaths } from '@wizardingcode/shibaox-daemon';
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
    discovery: false,
    home,
    store: new MemoryEventStore(),
    channels: [],
    env: {},
    log: () => {},
    version: '0.2.19',
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

  it('audit prints the run as Markdown (or JSON, or to a file); runs prune removes old finished runs', async () => {
    const { org, project, cli, dir } = await setup();
    const started = await cli(
      'run',
      'hello-feature',
      '--org',
      org,
      '--project',
      project,
      '--input',
      'audit me',
      '--adapter',
      'mock',
      '--workspace',
      'inplace',
      '--detach',
      '--json',
    );
    const [{ runId }] = json<{ runId: string }>(started);
    await vi.waitFor(async () => {
      expect(json<{ id: string }>(await cli('inbox', '--json')).map((i) => i.id)).toEqual([
        `human:${runId}:ship`,
      ]);
    });
    await cli('approve', `human:${runId}:ship`, '--note', 'go');
    await vi.waitFor(async () => {
      expect(json<{ status: string }>(await cli('runs', '--json'))[0]?.status).toBe('completed');
    });
    const md = await cli('audit', runId);
    expect(md.code, md.stderr).toBe(0);
    expect(md.stdout).toContain(`# Run ${runId} · hello-feature · completed`);
    expect(md.stdout).toContain('audit me');
    expect(md.stdout).toContain('go');
    const asJson = await cli('audit', runId, '--format', 'json');
    expect(JSON.parse(asJson.stdout)).toMatchObject({ runId, status: 'completed' });
    const file = join(dir, 'audit.md');
    const saved = await cli('audit', runId, '--out', file);
    expect(saved.stdout).toContain(file);
    expect(readFileSync(file, 'utf8')).toContain('# Run');
    const kept = await cli('runs', 'prune', '--before', '30d');
    expect(kept.stdout).toContain('Nothing to remove');
    const gone = await cli('runs', 'prune', '--before', '0d', '--json');
    expect(json<{ removed: string[] }>(gone)[0]?.removed).toEqual([runId]);
    expect((await cli('runs')).stdout).toContain('No runs yet.');
    const bad = await cli('runs', 'prune', '--before', 'yesterday');
    expect(bad.code).toBe(1);
  });

  it('run --setup off skips the dependency install a worktree run gets by default', async () => {
    const { org, project, cli, dir } = await setup();
    const git = (...a: string[]) => execFileSync('git', a, { cwd: project, stdio: 'ignore' });
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--no-gpg-sign', '-m', 'i');
    const common = [
      '--org',
      org,
      '--project',
      project,
      '--input',
      'x',
      '--adapter',
      'mock',
      '--workspace',
      'worktree',
      '--detach',
      '--json',
    ];
    const [{ runId: withSetup }] = json<{ runId: string }>(
      await cli('run', 'hello-feature', ...common),
    );
    const [{ runId: without }] = json<{ runId: string }>(
      await cli('run', 'hello-feature', ...common, '--setup', 'off'),
    );
    await vi.waitFor(async () => {
      const runs = json<{ runId: string; status: string }>(await cli('runs', '--json'));
      expect(runs.filter((r) => r.status === 'waiting_human')).toHaveLength(2);
    });
    // the sample has no lockfile: `npm install` runs in the worktree before the first task
    expect((await cli('replay', withSetup)).stdout).toMatch(
      /NodeStarted setup[\s\S]*NodeCompleted setup[\s\S]*NodeStarted analyse/,
    );
    expect((await cli('replay', without)).stdout).not.toContain('setup');
    void dir;
  });

  it('routine add/list/show/pause/resume/run/rm and sync from org/routines; schedule stays an alias', async () => {
    const { org, project, cli } = await setup({ store: undefined });
    const added = await cli(
      'routine',
      'add',
      'hello-feature',
      '--on',
      'cron:0 9 * * 1-5',
      '--org',
      org,
      '--project',
      project,
      '--input',
      'daily',
      '--adapter',
      'mock',
      '--name',
      'Daily',
      '--json',
    );
    expect(added.code, added.stderr).toBe(0);
    const [r] = json<{ id: string; trigger: { type: string } }>(added);
    expect(r?.trigger).toEqual({ type: 'cron', cron: '0 9 * * 1-5' });
    const gh = await cli(
      'routine',
      'add',
      'hello-feature',
      '--on',
      'github:issues',
      '--label',
      'bug',
      '--repo',
      'acme/app',
      '--every',
      '300',
      '--max-daily',
      '2',
      '--org',
      org,
      '--project',
      project,
      '--json',
    );
    expect(gh.code, gh.stderr).toBe(0);
    expect(json<{ trigger: unknown; intervalS: number; maxDailyUsd: number }>(gh)[0]).toMatchObject(
      {
        trigger: { type: 'github', watch: 'issues', label: 'bug', repo: 'acme/app' },
        intervalS: 300,
        maxDailyUsd: 2,
      },
    );
    const list = await cli('routine', 'list');
    expect(list.stdout).toContain('Daily');
    expect(list.stdout).toContain('github:issues');
    expect((await cli('routine', 'show', r?.id ?? '')).stdout).toContain('0 9 * * 1-5');
    expect((await cli('routine', 'pause', r?.id ?? '')).stdout).toContain('paused');
    expect((await cli('routine', 'list')).stdout).toMatch(/Daily.*off/);
    expect((await cli('routine', 'resume', r?.id ?? '')).stdout).toContain('resumed');
    const ran = await cli('routine', 'run', r?.id ?? '', '--json');
    expect(json<{ runId: string }>(ran)[0]?.runId).toMatch(/[0-9a-f-]{36}/);
    expect((await cli('schedule', 'list')).stdout).toContain('0 9 * * 1-5'); // the alias
    expect((await cli('routine', 'rm', r?.id ?? '')).stdout).toContain('Removed');
    const bad = await cli(
      'routine',
      'add',
      'hello-feature',
      '--on',
      'moon:full',
      '--org',
      org,
      '--project',
      project,
    );
    expect(bad.code).toBe(1);
    expect(bad.stdout + bad.stderr).toMatch(/cron:|github:|url:|file:|command:/);
    mkdirSync(join(org, 'routines'), { recursive: true });
    writeFileSync(
      join(org, 'routines', 'nightly.yaml'),
      'routine: nightly\non: { cron: "0 2 * * *" }\nworkflow: hello-feature\ninput: nightly\nproject: ../proj\n',
    );
    const synced = await cli('routine', 'sync', '--org', org);
    expect(synced.code, synced.stderr).toBe(0);
    expect(synced.stdout).toContain('added nightly');
  });

  it('run --issue reads the issue with gh and sets the github origin', async () => {
    const { org, project, dir, home, cli } = await setup();
    const bin = join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, 'gh'),
      `#!/bin/sh
printf '%s\n' "$*" >> "${join(dir, 'gh.log')}"
case "$1 $2" in
  "issue view") echo '{"number":12,"title":"Login broken","body":"Steps: open /login. Expected: form","url":"https://github.com/acme/app/issues/12","labels":[{"name":"bug"}]}' ;;
  "repo view") echo 'acme/app' ;;
esac
`,
    );
    chmodSync(join(bin, 'gh'), 0o755);
    const r = await new Promise<Result>((resolve) => {
      execFile(
        process.execPath,
        [
          bin.replace(/\/bin$/, ''),
          'run',
          'hello-feature',
          '--org',
          org,
          '--project',
          project,
          '--issue',
          '12',
          '--adapter',
          'mock',
          '--workspace',
          'inplace',
          '--detach',
          '--json',
        ].map((a, i) =>
          i === 0 ? fileURLToPath(new URL('../dist/index.js', import.meta.url)) : a,
        ),
        {
          env: {
            PATH: `${bin}:${process.env.PATH ?? ''}`,
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
    expect(r.code, r.stderr).toBe(0);
    const [{ runId }] = json<{ runId: string }>(r);
    const state = json<{ input: { spec: string }; origin?: string }>(
      await cli('replay', runId, '--json'),
    ).find((x) => x.origin !== undefined || x.input);
    void state;
    const runs = json<{ runId: string; origin?: string }>(await cli('runs', '--json'));
    expect(runs.find((x) => x.runId === runId)?.origin).toBe('github:acme/app#12');
    const md = await cli('audit', runId);
    expect(md.stdout).toContain('Issue #12: Login broken');
    expect(md.stdout).toContain('Steps: open /login');
    expect(md.stdout).toContain('https://github.com/acme/app/issues/12');
    expect(readFileSync(join(dir, 'gh.log'), 'utf8')).toContain('issue view 12');
  });

  it('steer sends a note to the running task of a run', async () => {
    let release: (() => void) | undefined;
    const { org, project, cli } = await setup({
      mockScript: async (job: TaskJob) => {
        if (job.nodeId === 'implement' && !job.resumeNote)
          await new Promise<void>((r) => {
            release = r;
          });
        return { output: { heard: job.resumeNote ?? null }, summary: job.nodeId };
      },
    });
    const started = await cli(
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
    );
    const [{ runId }] = json<{ runId: string }>(started);
    await vi.waitFor(async () => {
      const runs = json<{ runId: string; status: string }>(await cli('runs', '--json'));
      expect(runs.find((r) => r.runId === runId)?.status).toBe('running');
    });
    await new Promise((r) => setTimeout(r, 100));
    const steered = await cli('steer', runId, 'Try', 'the', 'other', 'way');
    expect(steered.code, steered.stderr).toBe(0);
    expect(steered.stdout).toContain('implement');
    await vi.waitFor(async () => {
      const runs = json<{ runId: string; status: string }>(await cli('runs', '--json'));
      expect(runs.find((r) => r.runId === runId)?.status).toBe('waiting_human');
    });
    const audit = await cli('audit', runId);
    expect(audit.stdout).toContain('Try the other way');
    release?.();
    const late = await cli('steer', runId, 'too late');
    expect(late.code).toBe(1);
  });

  it('daemon status reports the version and an empty inbox prints a sentence', async () => {
    const { cli } = await setup();
    const status = await cli('daemon', 'status');
    expect(status.stdout).toContain('version 0.2.19');
    expect((await cli('inbox')).stdout).toContain('Nothing waiting for you.');
    const st = json<{ version: string }>(await cli('daemon', 'status', '--json'));
    expect(st[0]?.version).toBe('0.2.19');
  });

  it('daemon stop waits for the active runs and says so', async () => {
    const { org, project, cli } = await setup({
      mockScript: async (job: TaskJob) => {
        await new Promise((r) => setTimeout(r, 1500));
        return { output: {}, summary: job.instruction };
      },
    });
    const started = await cli(
      'run',
      'hello-feature',
      '--org',
      org,
      '--project',
      project,
      '--input',
      'x',
      '--detach',
    );
    expect(started.code).toBe(0);
    const stop = await cli('daemon', 'stop');
    expect(stop.code).toBe(0);
    expect(stop.stdout).toMatch(/waiting for 1 active run/);
    expect(stop.stdout).toMatch(/Stopped\./);
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
    expect(list.stdout).toContain('…7890');
    expect(list.stdout).not.toContain('sk-o…');
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

describe('shibaox mcp', () => {
  it('list shows the catalog servers and who uses them; test connects and lists the tools', async () => {
    const s = await setup();
    const fixture = fileURLToPath(
      new URL('../../../packages/adapter-direct/test/fixtures/mcp-echo.mjs', import.meta.url),
    );
    writeFileSync(
      join(s.org, 'catalog', 'echo.yaml'),
      `id: echo\ntype: mcp\ndescription: echo server\nserver:\n  transport: stdio\n  command: ${process.execPath}\n  args: ['${fixture}']\n`,
    );
    appendFileSync(join(s.org, 'roles', 'backend.yaml'), 'mcp: [echo]\n');
    const list = await s.cli('mcp', 'list', '--org', s.org);
    expect(list.code, list.stderr).toBe(0);
    expect(list.stdout).toContain('echo');
    expect(list.stdout).toContain('backend');
    const test = await s.cli('mcp', 'test', 'echo', '--org', s.org);
    expect(test.code, test.stderr).toBe(0);
    expect(test.stdout).toMatch(/7 tools/);
    expect(test.stdout).toContain('shout');
    const nope = await s.cli('mcp', 'test', 'nope', '--org', s.org);
    expect(nope.code).not.toBe(0);
  });
});

describe('shibaox init --stack', () => {
  it('auto detects the sample repo as node, writes shibaox.yaml and the stack files; a wrong stack is refused', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-stack-'));
    tmpDirs.push(dir);
    cpSync(sample, dir, { recursive: true });
    const home = homePaths({ SHIBAOX_HOME: join(dir, 'home') });
    const cli = (...args: string[]) =>
      new Promise<Result>((resolve) => {
        execFile(
          process.execPath,
          [bin, ...args],
          {
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
    const r = await cli('init', dir, '--stack', 'auto');
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/stack: node/);
    const project = readFileSync(join(dir, 'shibaox.yaml'), 'utf8');
    expect(project).toContain('detected: tests: npm test'); // detection runs on every checkout: only a comment here
    expect(project).toMatch(/^protected:/m);
    expect(existsSync(join(dir, 'org', 'workflows', 'security-scan.yaml'))).toBe(true);
    expect(existsSync(join(dir, 'org', 'gates', 'typecheck.yaml'))).toBe(true); // resolved at run time; passes with a note when nothing is found
    const bad = await cli('init', join(dir, 'other'), '--stack', 'cobol');
    expect(bad.code).not.toBe(0);
    const none = await cli('init', join(dir, 'empty'), '--stack', 'auto');
    expect(none.code).toBe(0);
    expect(none.stdout).toMatch(/does not exist/i);
    const again = await cli('init', dir, '--stack', 'node');
    expect(again.code).toBe(0);
    expect(again.stdout).toMatch(/kept existing/i);
  });
});
