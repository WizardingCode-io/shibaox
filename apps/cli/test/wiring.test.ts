import { execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeQuery, msg } from '@shibaox/adapter-claude-code/testing';
import { AutoApproveHuman, MemoryEventStore } from '@shibaox/core';
import { SqliteEventStore } from '@shibaox/persistence-sqlite';
import type { ProviderEntry } from '@shibaox/providers';
import { startFakeOpenAI } from '@shibaox/providers/testing';
import { loadOrg } from '@shibaox/schemas';
import { afterEach, describe, expect, it } from 'vitest';
import { scaffoldOrg } from '../src/commands/init.js';
import { resumeRun } from '../src/commands/resume.js';
import { projectOf, runWorkflow } from '../src/commands/run.js';
import { worktreeList, worktreeRemove } from '../src/commands/worktree.js';
import { buildRuntime } from '../src/wiring.js';

const sample = fileURLToPath(new URL('../../../examples/sample-repo', import.meta.url));

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'wiring-'));
  tmpDirs.push(dir);
  scaffoldOrg(dir);
  const project = join(dir, 'project');
  cpSync(sample, project, { recursive: true });
  return { dir, org: join(dir, 'org'), project, db: join(dir, 'events.db') };
}

const unpricedFake: ProviderEntry = {
  id: 'fake',
  name: 'Fake',
  kind: 'openai-compatible',
  base_url: 'http://127.0.0.1:9/v1',
  auth: { type: 'none' },
  models: ['m'],
  pricing: {},
  verify: false,
  capabilities: { tools: true },
};

async function runCount(db: string): Promise<number> {
  const store = new SqliteEventStore(db);
  try {
    return (await store.listRuns()).length;
  } finally {
    store.close();
  }
}

describe('adapter selection and start checks', () => {
  it('run --adapter direct with an unconfigured strong tier rejects before any event', async () => {
    const { org, project, db } = setup();
    const lines: string[] = [];
    await expect(
      runWorkflow('hello-feature', {
        org,
        project,
        db,
        input: 'x',
        adapter: 'direct',
        env: {},
        human: new AutoApproveHuman(),
        log: (l) => lines.push(l),
      }),
    ).rejects.toThrow(/^cannot start: role "backend" → provider "anthropic" is not configured/);
    expect(await runCount(db)).toBe(0);
    expect(lines).toContain('adapter=direct');
    expect(lines).toContain('  analyst → ollama/llama3.2');
  });

  it('a plain run uses mock even with provider keys in the environment', async () => {
    const { org, project, db } = setup();
    const lines: string[] = [];
    const state = await runWorkflow('hello-feature', {
      org,
      project,
      db,
      input: 'x',
      env: { ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k' },
      human: new AutoApproveHuman(),
      log: (l) => lines.push(l),
    });
    expect(lines[0]).toBe('adapter=mock');
    expect(state.status).toBe('completed');
    expect(state.nodes.implement?.output).toEqual({
      instruction: 'Implement the request. Keep tests green.',
    });
    expect(state.nodes.judge?.choice).toBe('ship');
  });

  it('adapter: direct in org.yaml selects direct (and its start checks)', async () => {
    const { org, project, db } = setup();
    appendFileSync(join(org, 'org.yaml'), 'adapter: direct\n');
    await expect(
      runWorkflow('hello-feature', { org, project, db, input: 'x', env: {}, log: () => {} }),
    ).rejects.toThrow(/cannot start: role "backend"/);
    expect(await runCount(db)).toBe(0);
    // --adapter overrides org.yaml
    const state = await runWorkflow('hello-feature', {
      org,
      project,
      db,
      input: 'x',
      adapter: 'mock',
      env: {},
      human: new AutoApproveHuman(),
      log: () => {},
    });
    expect(state.status).toBe('completed');
  });

  it('resume applies the same rules and logs the adapter', async () => {
    const { org, project, db } = setup();
    const waiting = await runWorkflow('hello-feature', {
      org,
      project,
      db,
      input: 'x',
      adapter: 'mock',
      env: {},
      log: () => {},
      human: { ask: async () => ({ deferred: true }) },
    });
    expect(waiting.status).toBe('waiting_human');
    await expect(
      resumeRun(waiting.runId, { org, db, adapter: 'direct', env: {}, log: () => {} }),
    ).rejects.toThrow(/cannot start: role "backend"/);
    const lines: string[] = [];
    const done = await resumeRun(waiting.runId, {
      org,
      db,
      env: {},
      human: new AutoApproveHuman(),
      log: (l) => lines.push(l),
    });
    expect(lines[0]).toBe('adapter=mock');
    expect(done.status).toBe('completed');
  });

  it('warns that a budget cannot be enforced for unpriced direct models', () => {
    const { org: orgDir } = setup();
    const org = loadOrg(orgDir);
    org.models.tiers.strong = 'fake/m';
    org.models.tiers.cheap = 'fake/m';
    const common = {
      org,
      store: new MemoryEventStore(),
      human: new AutoApproveHuman(),
      log: () => {},
      adapter: 'direct' as const,
      workflow: org.workflows['hello-feature'],
      env: {},
      extraProviders: [unpricedFake],
    };
    const warned = buildRuntime({ ...common, budgetUsd: 5 }).warnings;
    expect(warned).toContain('model "fake/m" has no pricing: budget cannot be enforced for it');
    const noBudget = buildRuntime(common).warnings;
    expect(noBudget.some((w) => w.includes('no pricing'))).toBe(false);
  });
});

const pricedFake = (baseURL: string): ProviderEntry => ({
  ...unpricedFake,
  base_url: baseURL,
  pricing: { m: { input_per_m: 1, output_per_m: 1 } },
});

describe('claude-code adapter routing', () => {
  it('runs subscription roles on Claude Code and the rest direct', async () => {
    const { org, project, db } = setup();
    writeFileSync(
      join(org, 'models.yaml'),
      'tiers: { strong: anthropic-subscription/claude-sonnet-5, cheap: fake/m }\n',
    );
    const llm = await startFakeOpenAI(() => ({
      toolCalls: [{ name: 'finish', args: { output: { files: [] }, summary: 'analysed' } }],
    }));
    try {
      const q = fakeQuery(() => [msg.success('implemented')]);
      const lines: string[] = [];
      const state = await runWorkflow('hello-feature', {
        org,
        project,
        db,
        input: 'x',
        adapter: 'claude-code',
        queryFn: q,
        env: {},
        extraProviders: [pricedFake(llm.baseURL)],
        human: new AutoApproveHuman(),
        log: (l) => lines.push(l),
      });
      expect(state.status).toBe('completed');
      expect(lines).toContain('  analyst → fake/m');
      expect(lines).toContain('  backend → claude-code (claude-sonnet-5)');
      expect(state.nodes.analyse?.summary).toBe('analysed');
      expect(q.calls.map((c) => c.prompt.split('\n')[0])).toEqual([
        'Task: Implement the request. Keep tests green.',
      ]);
    } finally {
      await llm.close();
    }
  });

  it('refuses to start when a role routes to an unavailable runtime', async () => {
    const { org, project, db } = setup();
    writeFileSync(
      join(org, 'models.yaml'),
      'tiers: { strong: openai-codex-subscription/gpt-5-codex, cheap: anthropic-subscription/claude-haiku-4-5 }\n',
    );
    await expect(
      runWorkflow('hello-feature', {
        org,
        project,
        db,
        input: 'x',
        adapter: 'claude-code',
        queryFn: fakeQuery(() => []),
        env: {},
        log: () => {},
      }),
    ).rejects.toThrow(/^cannot start: role "backend" → role backend resolved to runtime codex/);
    expect(await runCount(db)).toBe(0);
  });

  it('refuses to start when a direct role of a claude-code run is not configured', async () => {
    const { org, project, db } = setup();
    writeFileSync(
      join(org, 'models.yaml'),
      'tiers: { strong: anthropic-subscription/claude-sonnet-5, cheap: openai/gpt-5-mini }\n',
    );
    await expect(
      runWorkflow('hello-feature', {
        org,
        project,
        db,
        input: 'x',
        adapter: 'claude-code',
        env: {},
        log: () => {},
      }),
    ).rejects.toThrow(/cannot start: role "analyst" → provider "openai" is not configured/);
  });
});

describe('vault and worktrees', () => {
  it('warns once when no vault is configured', async () => {
    const { org, project, db } = setup();
    writeFileSync(join(org, 'org.yaml'), 'organization: my-org\nteams: [engineering]\n');
    const lines: string[] = [];
    await runWorkflow('hello-feature', {
      org,
      project,
      db,
      input: 'x',
      env: {},
      human: new AutoApproveHuman(),
      log: (l) => lines.push(l),
    });
    expect(lines.filter((l) => l.includes('no vault'))).toEqual([
      'warn: no vault in org.yaml: run notes are not written',
    ]);
  });

  it('worktree list and rm manage the run worktrees', async () => {
    const { org, project, db } = setup();
    const git = (...a: string[]) => execFileSync('git', a, { cwd: project, stdio: 'ignore' });
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--no-gpg-sign', '-m', 'i');
    const state = await runWorkflow('hello-feature', {
      org,
      project,
      db,
      input: 'x',
      env: {},
      human: new AutoApproveHuman(),
      log: () => {},
    });
    expect(state.workspaceMode).toBe('worktree');
    const lines: string[] = [];
    await worktreeList({ project }, (l) => lines.push(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`shibaox/${state.runId}`);
    await worktreeRemove(state.runId, { project, deleteBranch: true }, () => {});
    lines.length = 0;
    await worktreeList({ project }, (l) => lines.push(l));
    expect(lines).toEqual(['no run worktrees']);
  });

  it('records the project and branch of a worktree run and prefers them over path parsing', async () => {
    const { org, project, db } = setup();
    const git = (...a: string[]) => execFileSync('git', a, { cwd: project, stdio: 'ignore' });
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--no-gpg-sign', '-m', 'i');
    const lines: string[] = [];
    const state = await runWorkflow('hello-feature', {
      org,
      project,
      db,
      input: 'x',
      env: {},
      human: new AutoApproveHuman(),
      log: (l) => lines.push(l),
    });
    const store = new SqliteEventStore(db);
    const created = (await store.read(state.runId))[0];
    store.close();
    expect(created).toMatchObject({
      type: 'RunCreated',
      project,
      branch: `shibaox/${state.runId}`,
    });
    expect(state.project).toBe(project);
    expect(state.branch).toBe(`shibaox/${state.runId}`);
    expect(projectOf(state)).toBe(project);
    const wt = join(project, '.shibaox', 'worktrees', state.runId);
    expect(lines).toContain(`worktree: ${wt} (branch shibaox/${state.runId})`);
    // a recorded project wins even when the workspace path does not follow the layout
    expect(projectOf({ ...state, workspace: '/elsewhere/ws' })).toBe(project);
    // old runs (no project/branch recorded) still resolve from the workspace path
    const old = { ...state, project: undefined, branch: undefined };
    expect(projectOf(old)).toBe(project);
    expect(projectOf({ ...old, workspaceMode: 'inplace' as const })).toBe(state.workspace);
  });

  it('inplace runs record the project and no branch', async () => {
    const { org, project, db } = setup();
    const state = await runWorkflow('hello-feature', {
      org,
      project,
      db,
      input: 'x',
      env: {},
      workspace: 'inplace',
      human: new AutoApproveHuman(),
      log: () => {},
    });
    expect(state.project).toBe(project);
    expect(state.branch).toBeUndefined();
  });

  it('resume refuses a worktree run whose worktree was removed', async () => {
    const { org, project, db } = setup();
    const git = (...a: string[]) => execFileSync('git', a, { cwd: project, stdio: 'ignore' });
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--no-gpg-sign', '-m', 'i');
    const waiting = await runWorkflow('hello-feature', {
      org,
      project,
      db,
      input: 'x',
      env: {},
      human: { ask: async (r) => (r.nodeId === 'ship' ? { deferred: true } : { approved: true }) },
      log: () => {},
    });
    expect(waiting.status).toBe('waiting_human');
    await worktreeRemove(waiting.runId, { project, deleteBranch: true }, () => {});
    const wt = join(project, '.shibaox', 'worktrees', waiting.runId);
    await expect(
      resumeRun(waiting.runId, { org, db, env: {}, human: new AutoApproveHuman(), log: () => {} }),
    ).rejects.toThrow(
      `cannot resume run ${waiting.runId}: its worktree ${wt} no longer exists (see: shibaox worktree list)`,
    );
  });

  it('falls back to inplace when the project is an untracked subfolder of a repo', async () => {
    const { dir, org, db } = setup();
    const gitAt = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, stdio: 'ignore' });
    const repo = join(dir, 'mono');
    cpSync(join(dir, 'project'), join(repo, 'app'), { recursive: true });
    writeFileSync(join(repo, 'README.md'), '# root\n');
    gitAt(repo, 'init', '-q', '-b', 'main');
    gitAt(repo, 'add', 'README.md');
    gitAt(
      repo,
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      'commit',
      '-q',
      '--no-gpg-sign',
      '-m',
      'i',
    );
    const lines: string[] = [];
    const state = await runWorkflow('hello-feature', {
      org,
      project: join(repo, 'app'),
      db,
      input: 'x',
      env: {},
      human: new AutoApproveHuman(),
      log: (l) => lines.push(l),
    });
    expect(lines).toContain('warn: project "app" is not tracked at HEAD; running in place');
    expect(state.workspaceMode).toBe('inplace');
    expect(state.workspace).toBe(join(repo, 'app'));
    expect(state.status).toBe('completed');
  });

  it('rejects an explicit worktree in a repo with no commits and creates nothing', async () => {
    const { org, project, db } = setup();
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project, stdio: 'ignore' });
    await expect(
      runWorkflow('hello-feature', {
        org,
        project,
        db,
        input: 'x',
        workspace: 'worktree',
        env: {},
        human: new AutoApproveHuman(),
        log: () => {},
      }),
    ).rejects.toThrow(
      'cannot use a worktree: project has no commits; commit first or use --workspace inplace',
    );
    expect(existsSync(join(project, '.shibaox'))).toBe(false);
    expect(await runCount(db)).toBe(0);
  });
});
