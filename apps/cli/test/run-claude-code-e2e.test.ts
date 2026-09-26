import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeQuery, msg } from '@shibaox/adapter-claude-code/testing';
import { AutoApproveHuman, DeferHuman, type RunState } from '@shibaox/core';
import { Graphify } from '@shibaox/memory';
import { SqliteEventStore } from '@shibaox/persistence-sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { scaffoldOrg } from '../src/commands/init.js';
import { resumeRun } from '../src/commands/resume.js';
import { runWorkflow } from '../src/commands/run.js';

const sample = fileURLToPath(new URL('../../../examples/sample-repo', import.meta.url));

function git(cwd: string, ...args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

const tmpDirs: string[] = [];
afterEach(() => {
  // run worktrees live inside the project, so removing the temp dir removes them too
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'cc-e2e-'));
  tmpDirs.push(dir);
  scaffoldOrg(dir);
  writeFileSync(
    join(dir, 'org/models.yaml'),
    'providers: {}\ntiers: { strong: anthropic-subscription/claude-sonnet-5, cheap: anthropic-subscription/claude-haiku-4-5, decision: jev-latest }\nroles: {}\ngates: {}\n',
  );
  writeFileSync(
    join(dir, 'org/org.yaml'),
    'organization: my-org\nbudgets: { per_run_usd: 5 }\nteams: [engineering]\nadapter: claude-code\nvault: ../vault\n',
  );
  const project = join(dir, 'proj');
  cpSync(sample, project, { recursive: true });
  git(project, 'init', '-q', '-b', 'main');
  git(project, 'add', '-A');
  git(
    project,
    '-c',
    'user.email=t@t',
    '-c',
    'user.name=t',
    'commit',
    '-q',
    '--no-gpg-sign',
    '-m',
    'init',
  );
  return {
    dir,
    org: join(dir, 'org'),
    project,
    db: join(dir, 'events.db'),
    vault: join(dir, 'vault'),
  };
}

async function runCreated(db: string, runId: string) {
  const store = new SqliteEventStore(db);
  try {
    const events = await store.read(runId);
    const e = events[0];
    if (e?.type !== 'RunCreated') throw new Error('no RunCreated');
    return e;
  } finally {
    store.close();
  }
}

const fakeGraphify = (python: string | undefined) =>
  new Graphify({
    exec: async ({ argv }) =>
      argv.some((a) => a.includes('sys.executable')) && python
        ? { exitCode: 0, stdout: `${python}\n`, stderr: '', timedOut: false }
        : { exitCode: 1, stdout: '', stderr: 'nope', timedOut: false },
  });

describe('shibaox run --adapter claude-code (fake SDK)', () => {
  it('runs hello-feature in a worktree and writes a vault note', async () => {
    const { org, project, db, vault } = setup();
    const q = fakeQuery(() => [msg.init(), msg.success('implemented')]);
    const lines: string[] = [];
    const state = await runWorkflow('hello-feature', {
      org,
      project,
      db,
      input: 'add a subtract function',
      adapter: 'claude-code',
      workspace: 'worktree',
      queryFn: q,
      human: new AutoApproveHuman(),
      env: {},
      vault,
      log: (l) => lines.push(l),
    });
    expect(state.status).toBe('completed');
    const created = await runCreated(db, state.runId);
    expect(created.adapter).toBe('claude-code');
    expect(created.workspaceMode).toBe('worktree');
    expect(created.workspace.endsWith(join('.shibaox', 'worktrees', state.runId))).toBe(true);
    expect(q.calls).toHaveLength(2);
    expect(q.calls[0]?.options.cwd).toBe(created.workspace);
    expect(q.calls[0]?.options.model).toBe('claude-haiku-4-5');
    expect(q.calls[1]?.options.model).toBe('claude-sonnet-5');
    expect(q.calls[0]?.options.mcpServers).toEqual({});
    const runs = readdirSync(join(vault, '10-projects', 'proj', 'runs'));
    expect(runs).toHaveLength(1);
    expect(lines).toContain(`note: ${join(vault, '10-projects', 'proj', 'runs', runs[0] ?? '')}`);
    expect(readdirSync(join(vault, '90-system', 'decisions'))).toHaveLength(1);
    expect(lines).toContain(`worktree: ${created.workspace} (branch shibaox/${state.runId})`);
    // the main checkout is untouched and the worktree is kept
    expect(existsSync(created.workspace)).toBe(true);
  });

  it('does not hand the API key to subscription roles', async () => {
    const { org, project, db, vault } = setup();
    writeFileSync(
      join(org, 'models.yaml'),
      'providers: {}\ntiers: { strong: anthropic-subscription/claude-sonnet-5, cheap: anthropic/claude-haiku-4-5, decision: jev-latest }\nroles: {}\ngates: {}\n',
    );
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-e2e';
    try {
      const q = fakeQuery(() => [msg.init(), msg.success('ok')]);
      await runWorkflow('hello-feature', {
        org,
        project,
        db,
        input: 'x',
        adapter: 'claude-code',
        workspace: 'inplace',
        queryFn: q,
        human: new AutoApproveHuman(),
        env: { ANTHROPIC_API_KEY: 'sk-ant-e2e' },
        vault,
        log: () => {},
      });
      expect(q.calls).toHaveLength(2);
      // analyse runs on anthropic/... (API key), implement on anthropic-subscription/...
      expect(q.calls[0]?.options.model).toBe('claude-haiku-4-5');
      expect(q.calls[0]?.options.env?.ANTHROPIC_API_KEY).toBe('sk-ant-e2e');
      expect(q.calls[1]?.options.model).toBe('claude-sonnet-5');
      expect(q.calls[1]?.options.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it('pauses on the Claude Code budget cap and resume --budget continues the task', async () => {
    const { org, project, db, vault } = setup();
    let implementCalls = 0;
    const q = fakeQuery((call) =>
      call.prompt.includes('Implement the request') && ++implementCalls === 1
        ? [msg.init(), msg.error('error_max_budget_usd', 5.2)]
        : [msg.init(), msg.success('ok', { total_cost_usd: 0.01 })],
    );
    const common = { org, db, queryFn: q, human: new AutoApproveHuman(), env: {}, log: () => {} };
    const paused = await runWorkflow('hello-feature', {
      ...common,
      project,
      input: 'x',
      adapter: 'claude-code',
      workspace: 'inplace',
      vault,
    });
    expect(paused.status).toBe('paused_budget');
    expect(paused.spentUsd).toBeCloseTo(5.21);
    expect(paused.nodes.implement?.status).toBe('pending');
    const done = await resumeRun(paused.runId, { ...common, budget: 20 });
    expect(done.status).toBe('completed');
    expect(implementCalls).toBe(2);
  });

  it('denies a push with interrupt when the human defers', async () => {
    const { org, project, db, vault } = setup();
    let decision: unknown;
    const q = fakeQuery(async function* (call) {
      yield msg.init();
      if (call.prompt.includes('Implement the request')) {
        const canUse = call.options.canUseTool;
        if (!canUse) throw new Error('no canUseTool');
        decision = await canUse('Bash', { command: 'git push' }, {
          signal: new AbortController().signal,
        } as Parameters<typeof canUse>[2]);
      }
      yield msg.success('done');
    });
    const state: RunState = await runWorkflow('hello-feature', {
      org,
      project,
      db,
      input: 'x',
      adapter: 'claude-code',
      queryFn: q,
      human: new DeferHuman(),
      env: {},
      vault,
      log: () => {},
    });
    expect(decision).toMatchObject({ behavior: 'deny', interrupt: true });
    const impl = q.calls.find((c) => c.prompt.includes('Implement the request'));
    const canUse = impl?.options.canUseTool;
    if (!canUse) throw new Error('implement call missing');
    await expect(
      canUse('Bash', { command: 'git push' }, {
        signal: new AbortController().signal,
      } as Parameters<typeof canUse>[2]),
    ).resolves.toMatchObject({ behavior: 'deny', interrupt: true });
    expect(state.status).toBe('failed');
    expect(state.nodes.implement?.error).toMatch(/approval pending for push/);
    // a failed run still gets a note
    expect(readdirSync(join(vault, '10-projects', 'proj', 'runs'))).toHaveLength(1);
  });

  it('attaches the graphify MCP when a graph exists, and inplace without git', async () => {
    const { org, project, db, vault } = setup();
    mkdirSync(join(project, 'graphify-out'));
    writeFileSync(join(project, 'graphify-out', 'graph.json'), '{}');
    const q = fakeQuery(() => [msg.success('ok')]);
    const state = await runWorkflow('hello-feature', {
      org,
      project,
      db,
      input: 'x',
      workspace: 'inplace',
      queryFn: q,
      graphify: fakeGraphify('/py/bin/python'),
      human: new AutoApproveHuman(),
      env: {},
      vault,
      log: () => {},
    });
    expect(state.status).toBe('completed');
    expect(state.workspace).toBe(project);
    expect(q.calls[0]?.options.mcpServers).toEqual({
      graphify: {
        type: 'stdio',
        command: '/py/bin/python',
        args: ['-m', 'graphify.serve', join(project, 'graphify-out', 'graph.json')],
      },
    });
    expect(q.calls[0]?.options.allowedTools).toContain('mcp__graphify__*');
  });

  it('skips the MCP with a warning when graphify python is missing, and --graph off', async () => {
    const { org, project, db, vault } = setup();
    mkdirSync(join(project, 'graphify-out'));
    writeFileSync(join(project, 'graphify-out', 'graph.json'), '{}');
    const q = fakeQuery(() => [msg.success('ok')]);
    const lines: string[] = [];
    await runWorkflow('hello-feature', {
      org,
      project,
      db,
      input: 'x',
      workspace: 'inplace',
      queryFn: q,
      graphify: fakeGraphify(undefined),
      human: new AutoApproveHuman(),
      env: {},
      vault,
      log: (l) => lines.push(l),
    });
    expect(q.calls[0]?.options.mcpServers).toEqual({});
    expect(lines.some((l) => l.startsWith('warn: graphify python not found'))).toBe(true);
    const q2 = fakeQuery(() => [msg.success('ok')]);
    await runWorkflow('hello-feature', {
      org,
      project,
      db,
      input: 'x',
      workspace: 'inplace',
      graph: 'off',
      queryFn: q2,
      graphify: fakeGraphify('/py'),
      human: new AutoApproveHuman(),
      env: {},
      vault,
      log: () => {},
    });
    expect(q2.calls[0]?.options.mcpServers).toEqual({});
  });

  it('does not attach the graph when the catalog lists graphify-mcp but autorouting does not pick it', async () => {
    const { org, project, db, vault } = setup();
    mkdirSync(join(org, 'catalog'));
    writeFileSync(
      join(org, 'catalog', 'graphify-mcp.yaml'),
      'id: graphify-mcp\ntype: mcp\ndescription: code knowledge graph\ntags: [frontend]\n',
    );
    mkdirSync(join(project, 'graphify-out'));
    writeFileSync(join(project, 'graphify-out', 'graph.json'), '{}');
    const q = fakeQuery(() => [msg.success('ok')]);
    const lines: string[] = [];
    await runWorkflow('hello-feature', {
      org,
      project,
      db,
      input: 'x',
      workspace: 'inplace',
      queryFn: q,
      graphify: fakeGraphify('/py'),
      human: new AutoApproveHuman(),
      env: {},
      vault,
      log: (l) => lines.push(l),
    });
    expect(q.calls[0]?.options.mcpServers).toEqual({});
    expect(lines).toContain('autoroute: attach=[] ambiguous=[graphify-mcp]');
  });

  it('resume reuses the adapter recorded in the run', async () => {
    const { org, project, db, vault } = setup();
    const q = fakeQuery(() => [msg.success('ok')]);
    const waiting = await runWorkflow('hello-feature', {
      org,
      project,
      db,
      input: 'x',
      adapter: 'claude-code',
      workspace: 'inplace',
      queryFn: q,
      human: { ask: async (r) => (r.nodeId === 'ship' ? { deferred: true } : { approved: true }) },
      env: {},
      vault,
      log: () => {},
    });
    expect(waiting.status).toBe('waiting_human');
    expect(existsSync(join(vault, '10-projects', 'proj', 'runs'))).toBe(false);
    // org.yaml now says mock; the run keeps claude-code
    writeFileSync(
      join(org, 'org.yaml'),
      'organization: my-org\nteams: [engineering]\nadapter: mock\nvault: ../vault\n',
    );
    const lines: string[] = [];
    const done = await resumeRun(waiting.runId, {
      org,
      db,
      queryFn: q,
      human: new AutoApproveHuman(),
      env: {},
      log: (l) => lines.push(l),
    });
    expect(lines[0]).toBe('adapter=claude-code');
    expect(done.status).toBe('completed');
    expect(readdirSync(join(vault, '10-projects', 'proj', 'runs'))).toHaveLength(1);
  });
});
