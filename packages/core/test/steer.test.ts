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
      /not running/,
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
