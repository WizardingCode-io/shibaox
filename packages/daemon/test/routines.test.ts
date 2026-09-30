import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunState } from '@wizardingcode/shibaox-core';
import { RoutinesRepo, SqliteEventStore } from '@wizardingcode/shibaox-persistence-sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { Routines } from '../src/routines.js';
import type { RunManager, SubmitRequest } from '../src/run-manager.js';

let dir: string;
let store: SqliteEventStore;
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function fakeRuns() {
  const submitted: SubmitRequest[] = [];
  const statuses = new Map<string, string>();
  const spent = new Map<string, number>();
  let n = 0;
  const runs = {
    submit: async (req: SubmitRequest) => {
      submitted.push(req);
      const runId = `run-${++n}`;
      statuses.set(runId, 'running');
      return { runId, warnings: [] };
    },
    state: async (runId: string) => ({ runId, status: statuses.get(runId) ?? 'completed' }),
    list: async () =>
      [...statuses.entries()].map(([runId, status], i) => ({
        runId,
        status,
        workflow: 'wf',
        createdAt: '2026-09-26T10:00:00.000Z',
        updatedAt: '2026-09-26T10:00:00.000Z',
        spentUsd: spent.get(runId) ?? 0,
        origin: submitted[i]?.origin,
      })),
  } as unknown as RunManager;
  return {
    runs,
    submitted,
    finish: (id: string, status = 'completed', usd = 0) => {
      statuses.set(id, status);
      spent.set(id, usd);
    },
  };
}

/** A `gh`/`git` stand-in whose answers the test sets. */
function fakeExec() {
  const answers = new Map<string, string>();
  const calls: string[][] = [];
  const envs: (Record<string, string> | undefined)[] = [];
  const exec = async ({ argv, env }: { argv: string[]; env?: Record<string, string> }) => {
    calls.push(argv);
    envs.push(env);
    const key = argv.slice(0, 3).join(' ');
    const out = answers.get(key) ?? answers.get(argv[0] ?? '');
    return {
      exitCode: out === undefined ? 1 : 0,
      stdout: out ?? '',
      stderr: out === undefined ? 'nope' : '',
      timedOut: false,
    };
  };
  return { exec, calls, answers, envs };
}

function setup(o: { vault?: boolean } = {}) {
  dir = mkdtempSync(join(tmpdir(), 'routines-'));
  store = new SqliteEventStore(join(dir, 'e.db'));
  const repo = new RoutinesRepo(store.db);
  const fr = fakeRuns();
  const ex = fakeExec();
  let t = Date.parse('2026-09-26T10:00:30.000Z');
  const logs: string[] = [];
  const pages = new Map<string, string>();
  const vault = o.vault ? join(dir, 'vault') : undefined;
  if (vault) mkdirSync(vault, { recursive: true });
  const routines = new Routines({
    repo,
    runs: fr.runs,
    log: (l) => logs.push(l),
    now: () => new Date(t),
    env: () => ({ GH_TOKEN: 'ghp_vault' }),
    exec: ex.exec as never,
    fetch: (async (url: string) =>
      new Response(pages.get(url) ?? 'nothing', { status: pages.has(url) ? 200 : 404 })) as never,
    vaultFor: () => vault,
  });
  return {
    repo,
    routines,
    ...fr,
    ...ex,
    logs,
    pages,
    vault,
    advance: (ms: number) => (t += ms),
    dir,
  };
}

const base = { orgRoot: '/org', project: '/p', workflow: 'wf', input: 'hi' };

describe('Routines: cron', () => {
  it('fires a due cron routine once per occurrence, with origin routine:<id>, like the old scheduler', async () => {
    const { routines, submitted, advance, repo } = setup();
    const r = routines.add({
      ...base,
      trigger: { type: 'cron', cron: '* * * * *' },
      adapter: 'mock',
      budgetUsd: 2,
    });
    await routines.tick();
    expect(submitted).toEqual([]);
    advance(30_000);
    await routines.tick();
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({
      orgRoot: '/org',
      project: '/p',
      workflow: 'wf',
      adapter: 'mock',
      budgetUsd: 2,
      origin: `routine:${r.id}`,
    });
    expect(submitted[0]?.input).toContain('hi');
    expect(repo.get(r.id)?.lastRunId).toBe('run-1');
    advance(60_000);
    await routines.tick(); // the previous run is still running: skipped
    expect(submitted).toHaveLength(1);
  });
  it('refuses an invalid cron expression and pause/resume gate the firing', async () => {
    const { routines, submitted, advance } = setup();
    expect(() => routines.add({ ...base, trigger: { type: 'cron', cron: 'nope' } })).toThrow(
      /cron/,
    );
    const r = routines.add({ ...base, trigger: { type: 'cron', cron: '* * * * *' } });
    routines.setEnabled(r.id, false);
    advance(60_000);
    await routines.tick();
    expect(submitted).toEqual([]);
    routines.setEnabled(r.id, true);
    advance(60_000);
    await routines.tick();
    expect(submitted).toHaveLength(1);
  });
});

describe('Routines: watchers', () => {
  it('github issues: fires when the labelled issues change, says "unchanged" otherwise, hands the data to the run as data', async () => {
    const { routines, submitted, advance, answers, calls, logs, finish } = setup();
    answers.set(
      'gh issue list',
      JSON.stringify([
        {
          number: 12,
          title: 'Login broken',
          updatedAt: 't1',
          url: 'https://github.com/acme/app/issues/12',
        },
      ]),
    );
    const r = routines.add({
      ...base,
      trigger: { type: 'github', watch: 'issues', repo: 'acme/app', label: 'bug' },
    });
    await routines.tick();
    expect(submitted).toHaveLength(1); // the first look fires: there is something to look at
    expect(
      calls.some(
        (c) =>
          c[0] === 'gh' && c.includes('--label') && c.includes('bug') && c.includes('acme/app'),
      ),
    ).toBe(true);
    expect(submitted[0]?.input).toContain('Login broken');
    expect(submitted[0]?.input).toMatch(/data.*not instructions/i);
    finish('run-1');
    advance(60_000);
    await routines.tick(); // before the interval: not even looked at
    expect(calls.filter((c) => c[0] === 'gh')).toHaveLength(1);
    advance(120_000);
    await routines.tick();
    expect(submitted).toHaveLength(1);
    expect(logs.join('\n')).toMatch(new RegExp(`${r.id}.*unchanged`));
    answers.set(
      'gh issue list',
      JSON.stringify([{ number: 12 }, { number: 13, title: 'Crash', updatedAt: 't2' }]),
    );
    advance(120_000);
    await routines.tick();
    expect(submitted).toHaveLength(2);
    expect(submitted[1]?.input).toContain('Crash');
  });
  it('github: the repo comes from the project remote when not given; nothing to watch is not a firing', async () => {
    const { routines, submitted, answers, calls } = setup();
    answers.set('git -C /p', 'git@github.com:acme/app.git\n');
    answers.set('gh pr list', '[]');
    routines.add({ ...base, trigger: { type: 'github', watch: 'prs' } });
    await routines.tick();
    expect(calls.some((c) => c[0] === 'gh' && c.includes('acme/app'))).toBe(true);
    expect(submitted).toEqual([]); // an empty list is nothing to act on
  });
  it('checks: a red run on the branch fires once, and again only when the set of runs changes', async () => {
    const { routines, submitted, answers, advance, finish } = setup();
    answers.set(
      'gh run list',
      JSON.stringify([{ databaseId: 1, status: 'completed', conclusion: 'failure', name: 'ci' }]),
    );
    routines.add({
      ...base,
      trigger: { type: 'github', watch: 'checks', repo: 'acme/app', branch: 'main' },
    });
    await routines.tick();
    expect(submitted).toHaveLength(1);
    finish('run-1');
    advance(120_000);
    await routines.tick();
    expect(submitted).toHaveLength(1);
    answers.set(
      'gh run list',
      JSON.stringify([{ databaseId: 2, status: 'completed', conclusion: 'success', name: 'ci' }]),
    );
    advance(120_000);
    await routines.tick();
    expect(submitted).toHaveLength(1); // green: nothing to do
  });
  it('url and command triggers fingerprint what they see; mode always fires every interval', async () => {
    const { routines, submitted, pages, answers, advance, finish } = setup();
    pages.set('https://x.test/status', 'all good');
    const u = routines.add({
      ...base,
      trigger: { type: 'url', url: 'https://x.test/status' },
      intervalS: 60,
    });
    answers.set('sh', 'v1');
    routines.add({
      ...base,
      trigger: { type: 'command', command: 'echo v1' },
      mode: 'always',
      intervalS: 60,
    });
    await routines.tick();
    expect(submitted).toHaveLength(2);
    finish('run-1');
    finish('run-2');
    advance(60_000);
    await routines.tick();
    expect(submitted).toHaveLength(3); // only the `always` one
    expect(submitted[2]?.input).toContain('v1');
    finish('run-3');
    pages.set('https://x.test/status', 'DOWN');
    advance(60_000);
    await routines.tick();
    expect(submitted).toHaveLength(5);
    expect(
      submitted.find((s) => s.origin === `routine:${u.id}` && s.input.includes('DOWN')),
    ).toBeDefined();
  });
  it('file: fires when the file changes (mtime or size), and when it appears', async () => {
    const { routines, submitted, advance, dir: d, finish } = setup();
    const f = join(d, 'TODO.md');
    routines.add({ ...base, trigger: { type: 'file', path: f }, intervalS: 60 });
    await routines.tick();
    expect(submitted).toEqual([]); // missing: nothing yet
    writeFileSync(f, 'a');
    advance(60_000);
    await routines.tick();
    expect(submitted).toHaveLength(1);
    finish('run-1');
    advance(60_000);
    await routines.tick();
    expect(submitted).toHaveLength(1);
    writeFileSync(f, 'ab');
    utimesSync(f, new Date(), new Date(Date.now() + 5000));
    advance(60_000);
    await routines.tick();
    expect(submitted).toHaveLength(2);
  });
});

describe('Routines: guards, continuity, sync', () => {
  it('never fires while a run of the same routine is active, and stops for the day at maxDailyUsd', async () => {
    const { routines, submitted, advance, finish, logs } = setup();
    const r = routines.add({
      ...base,
      trigger: { type: 'cron', cron: '* * * * *' },
      maxDailyUsd: 1,
    });
    advance(60_000);
    await routines.tick();
    expect(submitted).toHaveLength(1);
    advance(60_000);
    await routines.tick();
    expect(submitted).toHaveLength(1); // run-1 still running
    finish('run-1', 'completed', 0.7);
    advance(60_000);
    await routines.tick();
    expect(submitted).toHaveLength(2);
    finish('run-2', 'completed', 0.5);
    advance(60_000);
    await routines.tick();
    expect(submitted).toHaveLength(2); // 1.2 ≥ 1: over budget for today
    expect(logs.join('\n')).toMatch(new RegExp(`${r.id}.*daily budget`));
  });
  it('keeps a continuity note per routine in the vault and feeds its last lines into the next input', async () => {
    const { routines, submitted, advance, vault, finish } = setup({ vault: true });
    const r = routines.add({ ...base, trigger: { type: 'cron', cron: '* * * * *' } });
    advance(60_000);
    await routines.tick();
    finish('run-1');
    routines.onFinished({
      runId: 'run-1',
      origin: `routine:${r.id}`,
      status: 'completed',
      spentUsd: 0.12,
      workflow: 'wf',
      nodes: {
        reply: {
          status: 'completed',
          attempts: 1,
          summary: 'Nothing changed since yesterday.\nSecond line',
          approvals: {},
        },
      },
    } as unknown as RunState);
    const note = readFileSync(join(vault as string, '90-system', 'routines', `${r.id}.md`), 'utf8');
    expect(note).toContain('run-1');
    expect(note).toContain('Nothing changed since yesterday.');
    expect(note).not.toContain('Second line');
    advance(60_000);
    await routines.tick();
    expect(submitted[1]?.input).toContain('Nothing changed since yesterday.');
    expect(submitted[1]?.input).toMatch(/previous runs/i);
  });
  it('sync loads org/routines/*.yaml: adds, updates in place (keeping state), removes the org ones that are gone', async () => {
    const { routines, repo, dir: d } = setup();
    const org = join(d, 'org');
    mkdirSync(join(org, 'routines'), { recursive: true });
    writeFileSync(
      join(org, 'routines', 'bugs.yaml'),
      'routine: bugs\non: { github: issues, label: bug }\nworkflow: fix-issue\ninput: Fix it\nproject: ../app\n',
    );
    writeFileSync(
      join(org, 'routines', 'nightly.yaml'),
      'routine: nightly\non: { cron: "0 2 * * *" }\nworkflow: chat\ninput: What changed?\nproject: ../app\nmax_daily_usd: 2\n',
    );
    const manual = routines.add({ ...base, trigger: { type: 'cron', cron: '* * * * *' } });
    let r = routines.sync(org);
    expect(r).toEqual({ added: ['bugs', 'nightly'], updated: [], removed: [] });
    expect(repo.get('bugs')).toMatchObject({
      source: 'org',
      orgRoot: org,
      project: join(d, 'app'),
      trigger: { type: 'github', watch: 'issues', label: 'bug' },
      mode: 'on_change',
    });
    repo.update('bugs', { lastFingerprint: 'fp', lastRunId: 'run-x' });
    writeFileSync(
      join(org, 'routines', 'bugs.yaml'),
      'routine: bugs\non: { github: issues, label: urgent }\nworkflow: fix-issue\ninput: Fix it now\nproject: ../app\n',
    );
    rmSync(join(org, 'routines', 'nightly.yaml'));
    r = routines.sync(org);
    expect(r).toEqual({ added: [], updated: ['bugs'], removed: ['nightly'] });
    expect(repo.get('bugs')).toMatchObject({
      trigger: { label: 'urgent' },
      input: 'Fix it now',
      lastFingerprint: 'fp',
      lastRunId: 'run-x',
    });
    expect(repo.get(manual.id)).toBeDefined(); // not from the org: untouched
  });
});

describe('Routines: review pass', () => {
  it('a change seen while the previous run is active is not lost: it fires once the run ends', async () => {
    const { routines, submitted, answers, advance, finish } = setup();
    answers.set('gh issue list', JSON.stringify([{ number: 10 }]));
    routines.add({ ...base, trigger: { type: 'github', watch: 'issues', repo: 'acme/app' } });
    await routines.tick();
    expect(submitted).toHaveLength(1);
    answers.set('gh issue list', JSON.stringify([{ number: 10 }, { number: 11 }]));
    advance(120_000);
    await routines.tick(); // seen, but run-1 is still active
    expect(submitted).toHaveLength(1);
    finish('run-1');
    advance(120_000);
    await routines.tick(); // nothing changed since the blocked look, and yet #11 was never handled
    expect(submitted).toHaveLength(2);
    expect(submitted[1]?.input).toContain('11');
  });
  it('gh and the command trigger get the daemon env (the vault GH_TOKEN); a failing look waits the interval', async () => {
    const { routines, answers, envs, calls, advance, logs } = setup();
    routines.add({
      ...base,
      trigger: { type: 'github', watch: 'issues', repo: 'acme/app' },
      intervalS: 600,
    });
    await routines.tick(); // gh fails: no answer set
    expect(envs.at(-1)).toMatchObject({ GH_TOKEN: 'ghp_vault' });
    expect(logs.join('\n')).toMatch(/gh issue list/);
    advance(60_000);
    await routines.tick();
    expect(calls.filter((c) => c[0] === 'gh')).toHaveLength(1); // not before its interval
    advance(600_000);
    answers.set('gh issue list', '[]');
    await routines.tick();
    expect(calls.filter((c) => c[0] === 'gh')).toHaveLength(2);
  });
  it('issues change by number, not by activity: a comment on an open issue is not a firing', async () => {
    const { routines, submitted, answers, advance, finish } = setup();
    answers.set('gh issue list', JSON.stringify([{ number: 10, updatedAt: 't1' }]));
    routines.add({ ...base, trigger: { type: 'github', watch: 'issues', repo: 'acme/app' } });
    await routines.tick();
    finish('run-1');
    answers.set('gh issue list', JSON.stringify([{ number: 10, updatedAt: 't2' }]));
    advance(120_000);
    await routines.tick();
    expect(submitted).toHaveLength(1);
  });
  it('checks: the default branch when none is given, cancelled runs are not red, only the latest run of each workflow counts', async () => {
    const { routines, submitted, answers, calls, advance, finish } = setup();
    answers.set('gh repo view', JSON.stringify({ defaultBranchRef: { name: 'develop' } }));
    answers.set(
      'gh run list',
      JSON.stringify([
        {
          databaseId: 3,
          status: 'completed',
          conclusion: 'cancelled',
          name: 'ci',
          workflowName: 'ci',
        },
        {
          databaseId: 2,
          status: 'completed',
          conclusion: 'success',
          name: 'ci',
          workflowName: 'ci',
        },
        {
          databaseId: 1,
          status: 'completed',
          conclusion: 'failure',
          name: 'ci',
          workflowName: 'ci',
        },
      ]),
    );
    routines.add({ ...base, trigger: { type: 'github', watch: 'checks', repo: 'acme/app' } });
    await routines.tick();
    expect(
      calls.some(
        (c) => c[0] === 'gh' && c[1] === 'run' && c.includes('--branch') && c.includes('develop'),
      ),
    ).toBe(true);
    expect(submitted).toEqual([]); // latest completed ci run is green; the old failure is history
    answers.set(
      'gh run list',
      JSON.stringify([
        {
          databaseId: 4,
          status: 'completed',
          conclusion: 'failure',
          name: 'ci',
          workflowName: 'ci',
        },
        {
          databaseId: 2,
          status: 'completed',
          conclusion: 'success',
          name: 'ci',
          workflowName: 'ci',
        },
      ]),
    );
    advance(120_000);
    await routines.tick();
    expect(submitted).toHaveLength(1);
    finish('run-1');
    answers.set(
      'gh run list',
      JSON.stringify([
        {
          databaseId: 5,
          status: 'completed',
          conclusion: 'success',
          name: 'ci',
          workflowName: 'ci',
        },
        {
          databaseId: 4,
          status: 'completed',
          conclusion: 'failure',
          name: 'ci',
          workflowName: 'ci',
        },
      ]),
    );
    advance(120_000);
    await routines.tick();
    expect(submitted).toHaveLength(1); // green again: nothing
  });
  it('watchers get a daily cap by default; child runs write no continuity line', async () => {
    const { routines, submitted, advance, finish, logs, vault } = setup({ vault: true });
    const r = routines.add({
      ...base,
      trigger: { type: 'command', command: 'echo x' },
      mode: 'always',
      intervalS: 60,
    });
    expect(routines.get(r.id)?.maxDailyUsd).toBe(10);
    await routines.tick();
    finish('run-1', 'completed', 10);
    advance(60_000);
    await routines.tick();
    expect(submitted).toHaveLength(1);
    expect(logs.join('\n')).toMatch(/daily budget/);
    routines.onFinished({
      runId: 'child',
      origin: `routine:${r.id}`,
      parentRunId: 'run-1',
      status: 'completed',
      spentUsd: 0,
      workflow: 'wf',
      nodes: {},
    } as unknown as RunState);
    expect(existsSync(join(vault as string, '90-system', 'routines', `${r.id}.md`))).toBe(false);
  });
  it('sync is the truth for org routines: removed fields are cleared, a pause survives, file paths resolve against the org, ids do not cross orgs', async () => {
    const { routines, repo, dir: d } = setup();
    const org = join(d, 'org');
    mkdirSync(join(org, 'routines'), { recursive: true });
    writeFileSync(
      join(org, 'routines', 'todo.yaml'),
      'routine: todo\non: { file: ./TODO.md }\nworkflow: chat\ninput: x\nproject: ../app\nmax_daily_usd: 3\nname: Todo\n',
    );
    routines.sync(org);
    expect(repo.get('todo')).toMatchObject({
      trigger: { type: 'file', path: join(org, 'TODO.md') },
      maxDailyUsd: 3,
      name: 'Todo',
    });
    routines.setEnabled('todo', false);
    writeFileSync(
      join(org, 'routines', 'todo.yaml'),
      'routine: todo\non: { file: ./TODO.md }\nworkflow: chat\ninput: x\nproject: ../app\n',
    );
    routines.sync(org);
    // cleared name; the removed cap falls back to the watchers' default; the pause survives
    expect(repo.get('todo')).toMatchObject({ enabled: false, name: undefined, maxDailyUsd: 10 });
    writeFileSync(
      join(org, 'routines', 'todo.yaml'),
      'routine: todo\non: { file: ./TODO.md }\nworkflow: chat\ninput: x\nproject: ../app\nenabled: true\n',
    );
    routines.sync(org);
    expect(repo.get('todo')?.enabled).toBe(true);
    const other = join(d, 'org2');
    mkdirSync(join(other, 'routines'), { recursive: true });
    writeFileSync(
      join(other, 'routines', 'todo.yaml'),
      'routine: todo\non: { cron: "* * * * *" }\nworkflow: chat\n',
    );
    expect(() => routines.sync(other)).toThrow(/another org/);
    expect(repo.get('todo')?.orgRoot).toBe(org);
  });
});
