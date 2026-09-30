import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrg, type RunEvent } from '@wizardingcode/shibaox-schemas';
import { describe, expect, it } from 'vitest';
import {
  AutoApproveHuman,
  MemoryEventStore,
  RunEngine,
  type RuntimeAdapter,
  replay,
  ScriptedDecider,
  type TaskJob,
} from '../src/index.js';

function scaffold(): string {
  const dir = mkdtempSync(join(tmpdir(), 'steer-'));
  const files: Record<string, string> = {
    'org.yaml': 'organization: wc\nteams: [eng]\n',
    'teams/eng.yaml': 'team: eng\nlead: tl\nroles: [tl, backend]\ngates: []\nworkflows: [one]\n',
    'roles/tl.yaml': 'role: tl\n',
    'roles/backend.yaml': 'role: backend\nruntime: mock\n',
    'workflows/one.yaml':
      'workflow: one\nteam: eng\nstart: work\nnodes:\n  work: { type: task, role: backend, instruction: build it }\n',
  };
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

/** A task that waits until it is aborted (or released), remembering what it was told. */
function slowAdapter() {
  const jobs: TaskJob[] = [];
  let release: (() => void) | undefined;
  const adapter: RuntimeAdapter = {
    id: 'mock',
    capabilities: () => [],
    async *run(job, ctx) {
      jobs.push(job);
      yield { type: 'started' };
      yield { type: 'session', runtime: 'mock', sessionId: `s-${jobs.length}` };
      if (job.resumeNote) {
        yield { type: 'result', output: { heard: job.resumeNote }, summary: 'redone' };
        return;
      }
      await new Promise<void>((resolve, reject) => {
        release = resolve;
        ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true });
      });
      yield { type: 'result', output: { heard: null }, summary: 'done' };
    },
  };
  return { adapter, jobs, release: () => release?.() };
}

describe('steering a running node', () => {
  it('aborts only that node, records NodeSteered, and re-runs it with the note and its session', async () => {
    const dir = scaffold();
    const store = new MemoryEventStore();
    const { adapter, jobs } = slowAdapter();
    const engine = new RunEngine({
      store,
      org: loadOrg(dir),
      adapters: { mock: adapter },
      decider: new ScriptedDecider({}),
      human: new AutoApproveHuman(),
    });
    const runId = await engine.create({
      workflow: 'one',
      input: { spec: 'x' },
      workspace: process.cwd(),
    });
    const running = engine.run(runId);
    await new Promise((r) => setTimeout(r, 30));
    expect((await engine.state(runId)).nodes.work?.status).toBe('running');
    const state = await engine.steer(runId, { note: 'Use the other library', via: 'cli' });
    expect(state.nodes.work?.steering?.at(-1)).toMatchObject({
      note: 'Use the other library',
      via: 'cli',
    });
    const final = await running;
    expect(final.status).toBe('completed');
    expect(final.nodes.work?.output).toEqual({
      heard: expect.stringContaining('Use the other library'),
    });
    expect(final.nodes.work?.attempts).toBe(2);
    expect(jobs).toHaveLength(2);
    expect(jobs[1]?.resumeSessionId).toBe('s-1'); // the runtime session survives the steer
    const types = (await store.read(runId)).map((e: RunEvent) => e.type);
    expect(types).toContain('NodeSteered');
    expect(types).not.toContain('NodeFailed');
    expect(types).not.toContain('RunCancelled');
  });
  it('steering names the node when several run, refuses a node that is not running, and a finished run', async () => {
    const dir = scaffold();
    const store = new MemoryEventStore();
    const { adapter, release } = slowAdapter();
    const engine = new RunEngine({
      store,
      org: loadOrg(dir),
      adapters: { mock: adapter },
      decider: new ScriptedDecider({}),
      human: new AutoApproveHuman(),
    });
    const runId = await engine.create({
      workflow: 'one',
      input: { spec: 'x' },
      workspace: process.cwd(),
    });
    const running = engine.run(runId);
    await new Promise((r) => setTimeout(r, 30));
    await expect(engine.steer(runId, { nodeId: 'nope', note: 'x', via: 'api' })).rejects.toThrow(
      /not a running task|not running/,
    );
    release();
    const final = await running;
    expect(final.status).toBe('completed');
    await expect(engine.steer(runId, { note: 'too late', via: 'api' })).rejects.toThrow(
      /not running|finished|completed/,
    );
  });
});

describe('the reducer', () => {
  it('NodeSteered puts the node back to pending, keeps its session and lists the note', () => {
    const at = '2026-09-30T10:00:00.000Z';
    const state = replay([
      { seq: 1, type: 'RunCreated', runId: 'r', at, workflow: 'w', input: {}, workspace: '/w' },
      { seq: 2, type: 'RunStarted', runId: 'r', at },
      { seq: 3, type: 'NodeStarted', runId: 'r', nodeId: 'a', at },
      {
        seq: 4,
        type: 'SessionStarted',
        runId: 'r',
        nodeId: 'a',
        at,
        runtime: 'mock',
        sessionId: 's1',
      },
      { seq: 5, type: 'NodeSteered', runId: 'r', nodeId: 'a', at, note: 'faster', via: 'telegram' },
    ]);
    expect(state.nodes.a).toMatchObject({
      status: 'pending',
      sessionId: 's1',
      steering: [{ note: 'faster', via: 'telegram', at }],
    });
    expect(state.status).toBe('running');
  });
});

describe('steering: the edges', () => {
  function orgWithGate(): string {
    const dir = mkdtempSync(join(tmpdir(), 'steer-'));
    const files: Record<string, string> = {
      'org.yaml': 'organization: wc\nteams: [eng]\n',
      'teams/eng.yaml': 'team: eng\nlead: tl\nroles: [tl, backend]\ngates: []\nworkflows: [g]\n',
      'roles/tl.yaml': 'role: tl\n',
      'roles/backend.yaml': 'role: backend\nruntime: mock\n',
      'gates/slow.yaml':
        'gate: slow\nchecks:\n  - { name: wait, type: code, command: "sleep 2" }\n',
      'workflows/g.yaml':
        'workflow: g\nteam: eng\nstart: work\nnodes:\n  work: { type: task, role: backend, instruction: build, next: qa }\n  qa: { type: gate, gates: [slow], on_pass: done, on_fail: work, max_retries: 1 }\n  done: { type: human, action: ok }\n',
    };
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(join(dir, rel, '..'), { recursive: true });
      writeFileSync(join(dir, rel), content);
    }
    return dir;
  }
  it('a gate (or anything that is not a task) cannot be steered: the note is refused, nothing is corrupted', async () => {
    const dir = orgWithGate();
    const store = new MemoryEventStore();
    const quick: RuntimeAdapter = {
      id: 'mock',
      capabilities: () => [],
      async *run() {
        yield { type: 'started' };
        yield { type: 'result', output: {}, summary: 'ok' };
      },
    };
    const engine = new RunEngine({
      store,
      org: loadOrg(dir),
      adapters: { mock: quick },
      decider: new ScriptedDecider({}),
      human: new AutoApproveHuman(),
    });
    const runId = await engine.create({ workflow: 'g', input: {}, workspace: process.cwd() });
    const running = engine.run(runId);
    await new Promise((r) => setTimeout(r, 300));
    expect((await engine.state(runId)).nodes.qa?.status).toBe('running');
    await expect(engine.steer(runId, { note: 'hurry', via: 'cli' })).rejects.toThrow(
      /not a running task|no task is running/,
    );
    const final = await running;
    expect(final.status).toBe('completed');
    expect((await store.read(runId)).some((e) => e.type === 'NodeSteered')).toBe(false);
  });
  it('an adapter that ignores the abort and finishes anyway: the finished attempt is set aside and the task re-runs with the note', async () => {
    const dir = scaffold();
    const store = new MemoryEventStore();
    const jobs: TaskJob[] = [];
    let steeredOnce = false;
    const stubborn: RuntimeAdapter = {
      id: 'mock',
      capabilities: () => [],
      async *run(job) {
        jobs.push(job);
        yield { type: 'started' };
        if (!job.resumeNote) {
          await new Promise((r) => setTimeout(r, 150)); // ignores ctx.signal
          yield { type: 'result', output: { attempt: 1 }, summary: 'ignored the abort' };
          return;
        }
        yield { type: 'result', output: { attempt: 2, note: job.resumeNote }, summary: 'redone' };
      },
    };
    const engine = new RunEngine({
      store,
      org: loadOrg(dir),
      adapters: { mock: stubborn },
      decider: new ScriptedDecider({}),
      human: new AutoApproveHuman(),
    });
    const runId = await engine.create({ workflow: 'one', input: {}, workspace: process.cwd() });
    const running = engine.run(runId);
    await new Promise((r) => setTimeout(r, 30));
    await engine.steer(runId, { note: 'the other way', via: 'api' });
    steeredOnce = true;
    const final = await running;
    expect(steeredOnce).toBe(true);
    expect(final.status).toBe('completed');
    expect(final.nodes.work?.output).toMatchObject({ attempt: 2 });
    expect(jobs).toHaveLength(2);
  });
  it('a steer that arrives after the task finished is refused, not silently recorded', async () => {
    const dir = scaffold();
    const store = new MemoryEventStore();
    const { adapter, release } = slowAdapter();
    const engine = new RunEngine({
      store,
      org: loadOrg(dir),
      adapters: { mock: adapter },
      decider: new ScriptedDecider({}),
      human: new AutoApproveHuman(),
    });
    const runId = await engine.create({ workflow: 'one', input: {}, workspace: process.cwd() });
    const running = engine.run(runId);
    await new Promise((r) => setTimeout(r, 30));
    release();
    await running;
    await expect(engine.steer(runId, { note: 'late', via: 'api' })).rejects.toThrow();
    expect((await store.read(runId)).some((e) => e.type === 'NodeSteered')).toBe(false);
  });
  it('what a steered attempt cost is counted against the run', async () => {
    const dir = scaffold();
    const store = new MemoryEventStore();
    const costly: RuntimeAdapter = {
      id: 'mock',
      capabilities: () => [],
      async *run(job, ctx) {
        yield { type: 'started' };
        if (job.resumeNote) {
          yield {
            type: 'result',
            output: {},
            summary: 'redone',
            cost: { usd: 0.1, inputTokens: 1, outputTokens: 1 },
          };
          return;
        }
        await new Promise<void>((resolve) =>
          ctx.signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        yield {
          type: 'error',
          message: 'aborted',
          cost: { usd: 0.4, inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const engine = new RunEngine({
      store,
      org: loadOrg(dir),
      adapters: { mock: costly },
      decider: new ScriptedDecider({}),
      human: new AutoApproveHuman(),
    });
    const runId = await engine.create({ workflow: 'one', input: {}, workspace: process.cwd() });
    const running = engine.run(runId);
    await new Promise((r) => setTimeout(r, 30));
    await engine.steer(runId, { note: 'x', via: 'api' });
    const final = await running;
    expect(final.spentUsd).toBeCloseTo(0.5);
  });
  it('the reducer ignores NodeSteered for a node that is not running (a late note never reopens a finished node)', () => {
    const at = '2026-09-30T10:00:00.000Z';
    const state = replay([
      { seq: 1, type: 'RunCreated', runId: 'r', at, workflow: 'w', input: {}, workspace: '/w' },
      { seq: 2, type: 'RunStarted', runId: 'r', at },
      { seq: 3, type: 'NodeStarted', runId: 'r', nodeId: 'a', at },
      { seq: 4, type: 'NodeCompleted', runId: 'r', nodeId: 'a', at, output: {}, summary: '' },
      { seq: 5, type: 'NodeSteered', runId: 'r', nodeId: 'a', at, note: 'late', via: 'api' },
    ]);
    expect(state.nodes.a?.status).toBe('completed');
    expect(state.nodes.a?.steering).toBeUndefined();
  });
  it("the orchestrator's note is not presented as the operator's", async () => {
    const dir = scaffold();
    const store = new MemoryEventStore();
    const { adapter, jobs } = slowAdapter();
    const engine = new RunEngine({
      store,
      org: loadOrg(dir),
      adapters: { mock: adapter },
      decider: new ScriptedDecider({}),
      human: new AutoApproveHuman(),
    });
    const runId = await engine.create({ workflow: 'one', input: {}, workspace: process.cwd() });
    const running = engine.run(runId);
    await new Promise((r) => setTimeout(r, 30));
    await engine.steer(runId, { note: 'use pnpm', via: 'orchestrator' });
    await running;
    expect(jobs[1]?.resumeNote).toMatch(/orchestrating agent/i);
    expect(jobs[1]?.resumeNote).not.toMatch(/from the operator/i);
  });
});
