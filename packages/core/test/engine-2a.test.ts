import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrg } from '@shibaox/schemas';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryEventStore } from '../src/events/memory-store.js';
import type { RuntimeAdapter, RuntimeEvent, TaskJob } from '../src/executors/types.js';
import { AutoApproveHuman, ScriptedDecider } from '../src/run/deciders.js';
import { RunEngine } from '../src/run/engine.js';

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function orgWithTask(): ReturnType<typeof loadOrg> {
  dir = mkdtempSync(join(tmpdir(), 'org2a-'));
  const files: Record<string, string> = {
    'org.yaml': 'organization: wc\nteams: [eng]\n',
    'teams/eng.yaml': 'team: eng\nlead: tl\nroles: [tl, backend]\ngates: []\nworkflows: [wf]\n',
    'roles/tl.yaml': 'role: tl\n',
    'roles/backend.yaml': 'role: backend\nruntime: fake\n',
    'workflows/wf.yaml':
      'workflow: wf\nteam: eng\nstart: impl\nnodes:\n  impl: { type: task, role: backend, instruction: do it }\n',
  };
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return loadOrg(dir);
}

function adapter(
  script: (job: TaskJob) => RuntimeEvent[] | Promise<RuntimeEvent[]>,
): RuntimeAdapter {
  return {
    id: 'fake',
    capabilities: () => ['shell'],
    async *run(job) {
      for (const e of await script(job)) yield e;
    },
  };
}

const deps = (store: MemoryEventStore, a: RuntimeAdapter, extra: object = {}) => ({
  store,
  org: orgWithTask(),
  adapters: { fake: a },
  defaultAdapter: 'fake',
  decider: new ScriptedDecider({}, 'ship'),
  human: new AutoApproveHuman(),
  now: () => '2026-09-26T00:00:00.000Z',
  ...extra,
});

const approvalRequested = (runId: string) =>
  ({
    type: 'ToolApprovalRequested',
    runId,
    nodeId: 'impl',
    at: 'x',
    approvalId: 'a1',
    role: 'backend',
    tool: 'Bash',
    program: 'git',
    category: 'push',
    command: 'git push origin main',
    argvHash: 'h1',
  }) as const;

describe('engine phase 2A', () => {
  it('create queues; run starts and completes', async () => {
    const store = new MemoryEventStore();
    const engine = new RunEngine(
      deps(
        store,
        adapter(() => [{ type: 'result', output: 1, summary: 'ok' }]),
      ),
    );
    const runId = await engine.create({
      workflow: 'wf',
      input: {},
      workspace: '/w',
      orgRoot: '/org',
    });
    expect((await engine.state(runId)).status).toBe('queued');
    const state = await engine.run(runId);
    expect(state.status).toBe('completed');
    expect(state.orgRoot).toBe('/org');
    const types = (await store.read(runId)).map((e) => e.type);
    expect(types.slice(0, 3)).toEqual(['RunCreated', 'RunStarted', 'NodeStarted']);
  });

  it('approval_pending suspends the node with its session id instead of failing', async () => {
    const store = new MemoryEventStore();
    const engine = new RunEngine(
      deps(
        store,
        adapter(async (job) => {
          // the approval request itself is appended by the inbox (daemon) while the task runs
          await store.append(approvalRequested(job.runId));
          return [
            { type: 'session', runtime: 'claude-code', sessionId: 'sess-9' },
            {
              type: 'error',
              message: 'approval pending',
              reason: 'approval_pending',
              approvalId: 'a1',
              cost: { usd: 0.1, inputTokens: 1, outputTokens: 1 },
            },
          ];
        }),
      ),
    );
    const runId = await engine.create({ workflow: 'wf', input: {}, workspace: '/w' });
    const state = await engine.run(runId);
    expect(state.status).toBe('waiting_approval');
    expect(state.nodes.impl).toMatchObject({ status: 'pending', sessionId: 'sess-9', attempts: 1 });
    expect(state.spentUsd).toBeCloseTo(0.1);
    const types = (await store.read(runId)).map((e) => e.type);
    expect(types).toContain('SessionStarted');
    expect(types).not.toContain('NodeFailed');
    expect(types.indexOf('SessionStarted')).toBeLessThan(types.indexOf('NodeSuspended'));
  });

  it('resume after the approval is resolved re-runs the node with resumeSessionId, resumeNote and approvedCommands', async () => {
    const store = new MemoryEventStore();
    const jobs: TaskJob[] = [];
    let calls = 0;
    const engine = new RunEngine(
      deps(
        store,
        adapter(async (job) => {
          jobs.push(job);
          if (++calls !== 1) return [{ type: 'result', output: 1, summary: 'done' }];
          await store.append(approvalRequested(job.runId));
          return [
            { type: 'session', runtime: 'claude-code', sessionId: 's1' },
            { type: 'error', message: 'p', reason: 'approval_pending', approvalId: 'a1' },
          ];
        }),
      ),
    );
    const runId = await engine.create({ workflow: 'wf', input: {}, workspace: '/w' });
    await engine.run(runId);
    await expect(engine.resume(runId)).rejects.toThrow('answer the pending approval first');
    await store.append({
      type: 'ToolApprovalResolved',
      runId,
      nodeId: 'impl',
      at: 'y',
      approvalId: 'a1',
      approved: true,
      via: 'cli',
    });
    const state = await engine.resume(runId);
    expect(state.status).toBe('completed');
    expect(jobs[0]?.resumeSessionId).toBeUndefined();
    expect(jobs[0]?.approvedCommands).toEqual({});
    expect(jobs[1]).toMatchObject({
      resumeSessionId: 's1',
      resumeNote: 'The approval for `git push origin main` was granted. Continue the task.',
      approvedCommands: { h1: true },
    });
  });

  it('suspend marks running nodes of a waiting_approval run as re-runnable', async () => {
    const store = new MemoryEventStore();
    const engine = new RunEngine(
      deps(
        store,
        adapter(() => []),
      ),
    );
    const runId = await engine.create({ workflow: 'wf', input: {}, workspace: '/w' });
    await store.append({ type: 'RunStarted', runId, at: 'x' });
    await store.append({ type: 'NodeStarted', runId, nodeId: 'impl', at: 'x' });
    await store.append({
      type: 'SessionStarted',
      runId,
      nodeId: 'impl',
      at: 'x',
      runtime: 'claude-code',
      sessionId: 's1',
    });
    await store.append(approvalRequested(runId));
    const state = await engine.suspend(runId);
    expect(state.nodes.impl).toMatchObject({ status: 'pending', sessionId: 's1' });
    expect((await store.read(runId)).at(-1)).toMatchObject({
      type: 'NodeSuspended',
      approvalId: 'a1',
      sessionId: 's1',
    });
  });

  it('streams runtime events through onRuntimeEvent and the store notifies subscribers', async () => {
    const store = new MemoryEventStore();
    const seen: string[] = [];
    const stored: string[] = [];
    const off = store.subscribe((e) => stored.push(e.type));
    const engine = new RunEngine(
      deps(
        store,
        adapter(() => [
          { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
          { type: 'tool_result', id: 't1', name: 'Bash', output: 'ok', durationMs: 5 },
          { type: 'result', output: 1, summary: 'ok' },
        ]),
        { onRuntimeEvent: (_r: string, _n: string, e: RuntimeEvent) => seen.push(e.type) },
      ),
    );
    await engine.start({ workflow: 'wf', input: {}, workspace: '/w' });
    expect(seen).toEqual(['tool_use', 'tool_result', 'result']);
    expect(stored).toContain('RunCompleted');
    off();
  });
});

describe('engine phase 2A: sessions and approvals after the final review', () => {
  it('a rework after a completed attempt starts a fresh session (no resumeSessionId)', async () => {
    const store = new MemoryEventStore();
    const jobs: TaskJob[] = [];
    let calls = 0;
    const engine = new RunEngine(
      deps(
        store,
        adapter((job) => {
          jobs.push(job);
          return [
            { type: 'session', runtime: 'claude-code', sessionId: `s${++calls}` },
            { type: 'result', output: 1, summary: 'ok' },
          ];
        }),
      ),
    );
    const runId = await engine.create({ workflow: 'wf', input: {}, workspace: '/w' });
    await engine.run(runId);
    // simulate a gate rework: the completed node runs again
    await store.append({ type: 'NodeStarted', runId, nodeId: 'impl', at: 'x' });
    const state = await engine.state(runId);
    expect(state.nodes.impl?.sessionId).toBeUndefined();
    expect(jobs[0]?.resumeSessionId).toBeUndefined();
  });

  it('an answer that lands after the timeout but before the task reports suspends and re-runs the node', async () => {
    const store = new MemoryEventStore();
    const jobs: TaskJob[] = [];
    let calls = 0;
    const engine = new RunEngine(
      deps(
        store,
        adapter(async (job) => {
          jobs.push(job);
          if (++calls !== 1) return [{ type: 'result', output: 1, summary: 'done' }];
          await store.append(approvalRequested(job.runId));
          // the human answers while the SDK is still being interrupted
          await store.append({
            type: 'ToolApprovalResolved',
            runId: job.runId,
            nodeId: 'impl',
            at: 'y',
            approvalId: 'a1',
            approved: true,
            via: 'cli',
          });
          return [
            { type: 'session', runtime: 'claude-code', sessionId: 's1' },
            { type: 'error', message: 'p', reason: 'approval_pending', approvalId: 'a1' },
          ];
        }),
      ),
    );
    const runId = await engine.create({ workflow: 'wf', input: {}, workspace: '/w' });
    const state = await engine.run(runId);
    expect(state.status).toBe('completed');
    const types = (await store.read(runId)).map((e) => e.type);
    expect(types).toContain('NodeSuspended');
    expect(types).not.toContain('NodeFailed');
    expect(jobs[1]).toMatchObject({ resumeSessionId: 's1', approvedCommands: { h1: true } });
  });
});
