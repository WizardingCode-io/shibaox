import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrg } from '@shibaox/schemas';
import { describe, expect, it } from 'vitest';
import {
  AutoApproveHuman,
  DeferHuman,
  MemoryEventStore,
  MockAdapter,
  RunEngine,
  type RuntimeAdapter,
  ScriptedDecider,
} from '../src/index.js';

function scaffold(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'org-'));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

const orgFiles = (gateCmd: string) => ({
  'org.yaml': 'organization: wc\nteams: [eng]\n',
  'teams/eng.yaml':
    'team: eng\nlead: tl\nroles: [tl, analyst, backend]\ngates: [tests]\nworkflows: [hello]\n',
  'roles/tl.yaml': 'role: tl\n',
  'roles/analyst.yaml': 'role: analyst\nruntime: mock\n',
  'roles/backend.yaml': 'role: backend\nruntime: mock\n',
  'gates/tests.yaml': `gate: tests\nchecks:\n  - { name: t, type: code, command: "${gateCmd}" }\n`,
  'workflows/hello.yaml': [
    'workflow: hello',
    'team: eng',
    'start: analyse',
    'nodes:',
    '  analyse: { type: task, role: analyst, instruction: analyse, next: implement }',
    '  implement: { type: task, role: backend, instruction: implement, next: qa }',
    '  qa: { type: gate, gates: [tests], on_pass: judge, on_fail: implement, max_retries: 1 }',
    '  judge: { type: decide, by: tl, question: ready?, options: [ship, rework], next: { ship: ship, rework: implement } }',
    '  ship: { type: human, action: approve-push, prompt: push? }',
    '',
  ].join('\n'),
});

function engineFor(
  dir: string,
  overrides: Partial<ConstructorParameters<typeof RunEngine>[0]> = {},
) {
  const store = overrides.store ?? new MemoryEventStore();
  const engine = new RunEngine({
    store,
    org: loadOrg(dir),
    adapters: {
      mock: new MockAdapter((j) => ({
        output: { did: j.instruction },
        summary: j.instruction,
        cost: { usd: 0.1, inputTokens: 1, outputTokens: 1 },
      })),
    },
    decider: new ScriptedDecider({ judge: 'ship' }),
    human: new AutoApproveHuman(),
    now: () => '2026-09-25T10:00:00.000Z',
    ...overrides,
  });
  return { store, engine };
}

describe('RunEngine', () => {
  it('runs the hello workflow end to end', async () => {
    const { engine, store } = engineFor(scaffold(orgFiles('true')));
    const state = await engine.start({
      workflow: 'hello',
      input: { spec: 'x' },
      workspace: process.cwd(),
    });
    expect(state.status).toBe('completed');
    expect(Object.keys(state.nodes).sort()).toEqual([
      'analyse',
      'implement',
      'judge',
      'qa',
      'ship',
    ]);
    expect(state.nodes.implement?.output).toEqual({ did: 'implement' });
    expect(state.spentUsd).toBeCloseTo(0.2);
    const types = (await store.read(state.runId)).map((e) => e.type);
    expect(types[0]).toBe('RunCreated');
    expect(types.at(-1)).toBe('RunCompleted');
    expect(types).toContain('GatePassed');
    expect(types).toContain('DecisionMade');
  });

  it('counts the cost of a failed task attempt (adapter error with cost)', async () => {
    const failing: RuntimeAdapter = {
      id: 'mock',
      capabilities: () => [],
      async *run() {
        yield { type: 'started' };
        yield {
          type: 'error',
          message: 'max steps reached',
          cost: { usd: 0.3, inputTokens: 100, outputTokens: 50 },
        };
      },
    };
    const { engine, store } = engineFor(scaffold(orgFiles('true')), {
      adapters: { mock: failing },
    });
    const state = await engine.start({ workflow: 'hello', input: {}, workspace: process.cwd() });
    expect(state.status).toBe('failed');
    expect(state.spentUsd).toBeCloseTo(0.3);
    const failed = (await store.read(state.runId)).find((e) => e.type === 'NodeFailed');
    expect(failed && 'cost' in failed && failed.cost?.usd).toBeCloseTo(0.3);
  });

  it('passes the run abort signal to check runners and deciders', async () => {
    const seen: string[] = [];
    const { engine } = engineFor(scaffold(orgFiles('true')), {
      checkRunners: {
        code: async (check, ctx) => {
          if (ctx.signal instanceof AbortSignal) seen.push('check');
          return { name: check.name, type: 'code', passed: true, skipped: false, evidence: '' };
        },
      },
      decider: {
        decide: async (req) => {
          if (req.signal instanceof AbortSignal) seen.push('decide');
          return { choice: 'ship' };
        },
      },
    });
    const state = await engine.start({ workflow: 'hello', input: {}, workspace: process.cwd() });
    expect(state.status).toBe('completed');
    expect(seen).toEqual(['check', 'decide']);
  });

  it('gate failure reworks then fails the run after max_retries with the report', async () => {
    const { engine, store } = engineFor(scaffold(orgFiles('exit 1')));
    const state = await engine.start({ workflow: 'hello', input: {}, workspace: process.cwd() });
    expect(state.status).toBe('failed');
    expect(state.error).toContain('gate failed after 2 attempts');
    expect(state.nodes.implement?.attempts).toBe(2);
    const types = (await store.read(state.runId)).map((e) => e.type);
    expect(types.filter((t) => t === 'GateFailed')).toHaveLength(1);
    expect(types.filter((t) => t === 'NodeFailed')).toHaveLength(1);
  });

  it('passes the last gate report to the reworked task', async () => {
    const seen: unknown[] = [];
    const dir = scaffold(orgFiles('exit 1'));
    const { engine } = engineFor(dir, {
      adapters: {
        mock: new MockAdapter((j) => {
          seen.push(j.context.lastGateReport);
          return { output: null, summary: '' };
        }),
      },
    });
    await engine.start({ workflow: 'hello', input: {}, workspace: process.cwd() });
    expect(seen[0]).toBeUndefined(); // analyse
    expect(seen[1]).toBeUndefined(); // implement, first try
    expect(seen[2]).toMatchObject({ passed: false }); // implement, rework
  });

  it('pauses on budget and resumes with a higher budget', async () => {
    const { engine } = engineFor(scaffold(orgFiles('true')));
    const paused = await engine.start({
      workflow: 'hello',
      input: {},
      workspace: process.cwd(),
      budgetUsd: 0.15,
    });
    expect(paused.status).toBe('paused_budget');
    expect(paused.nodes.qa).toBeUndefined();
    const done = await engine.resume(paused.runId, { budgetUsd: 5 });
    expect(done.status).toBe('completed');
  });

  it('defers a human decision, then respond() finishes the run', async () => {
    const { engine } = engineFor(scaffold(orgFiles('true')), { human: new DeferHuman() });
    const waiting = await engine.start({ workflow: 'hello', input: {}, workspace: process.cwd() });
    expect(waiting.status).toBe('waiting_human');
    expect(waiting.pendingHumans.map((p) => p.nodeId)).toEqual(['ship']);
    const done = await engine.respond(waiting.runId, { approved: true });
    expect(done.status).toBe('completed');
  });

  it('a rejected human approval cancels the run', async () => {
    const { engine, store } = engineFor(scaffold(orgFiles('true')), {
      human: { ask: async () => ({ approved: false, note: 'no' }) },
    });
    const s = await engine.start({ workflow: 'hello', input: {}, workspace: process.cwd() });
    expect(s.status).toBe('cancelled');
    expect(s.error).toBe('rejected by human at ship: no');
    const types = (await store.read(s.runId)).map((e) => e.type);
    expect(types.at(-1)).toBe('HumanResponded');
    expect(types).not.toContain('RunCancelled');
  });

  it('fails the task node when no adapter matches the role runtime', async () => {
    const dir = scaffold({
      ...orgFiles('true'),
      'roles/analyst.yaml': 'role: analyst\nruntime: claude-code\n',
    });
    const { engine } = engineFor(dir);
    const s = await engine.start({ workflow: 'hello', input: {}, workspace: process.cwd() });
    expect(s.status).toBe('failed');
    expect(s.error).toContain('no adapter registered for runtime "claude-code"');
  });

  it('resume after a crash re-runs the interrupted node without repeating completed ones', async () => {
    const dir = scaffold(orgFiles('true'));
    const calls: string[] = [];
    const { engine, store } = engineFor(dir, {
      adapters: {
        mock: new MockAdapter((j) => {
          calls.push(j.nodeId);
          return { output: null, summary: '' };
        }),
      },
    });
    const at = '2026-09-25T10:00:00.000Z';
    await store.append({
      type: 'RunCreated',
      runId: 'crash',
      at,
      workflow: 'hello',
      input: {},
      workspace: process.cwd(),
    });
    await store.append({ type: 'NodeStarted', runId: 'crash', nodeId: 'analyse', at });
    await store.append({
      type: 'NodeCompleted',
      runId: 'crash',
      nodeId: 'analyse',
      at,
      output: 1,
      summary: '',
    });
    await store.append({ type: 'NodeStarted', runId: 'crash', nodeId: 'implement', at });
    const s = await engine.resume('crash');
    expect(s.status).toBe('completed');
    expect(calls).toEqual(['implement']);
    expect(s.nodes.implement?.attempts).toBe(2);
  });

  it('keeps the run failed when a parallel human sibling races a task failure', async () => {
    const dir = scaffold({
      'org.yaml': 'organization: wc\nteams: [eng]\n',
      'teams/eng.yaml': 'team: eng\nlead: tl\nroles: [tl, analyst]\nworkflows: [par]\n',
      'roles/tl.yaml': 'role: tl\n',
      'roles/analyst.yaml': 'role: analyst\nruntime: mock\n',
      'workflows/par.yaml': [
        'workflow: par',
        'team: eng',
        'start: p',
        'nodes:',
        '  p: { type: parallel, branches: [bad, ask], join: done }',
        '  bad: { type: task, role: analyst, instruction: bad }',
        '  ask: { type: human, action: ok }',
        '  done: { type: human, action: fin }',
        '',
      ].join('\n'),
    });
    const { engine } = engineFor(dir, {
      adapters: {
        mock: new MockAdapter(() => {
          throw new Error('boom');
        }),
      },
    });
    const s = await engine.start({ workflow: 'par', input: {}, workspace: process.cwd() });
    expect(s.status).toBe('failed');
    expect(s.error).toContain('bad');
    expect(s.nodes.done).toBeUndefined();
  });

  it('cancels a workflow that would loop forever', async () => {
    const dir = scaffold({
      ...orgFiles('true'),
      'teams/eng.yaml': 'team: eng\nlead: tl\nroles: [tl, analyst, backend]\nworkflows: [hello]\n',
      'workflows/hello.yaml':
        'workflow: hello\nstart: a\nnodes:\n  a: { type: decide, by: tl, options: [again, again2], next: { again: b, again2: b } }\n  b: { type: gate, gates: [tests], on_pass: a, on_fail: a, max_retries: 0 }\n',
    });
    const { engine } = engineFor(dir, { decider: new ScriptedDecider({}, 'again'), maxSteps: 10 });
    const s = await engine.start({ workflow: 'hello', input: {}, workspace: process.cwd() });
    expect(s.status).toBe('cancelled');
    expect(s.error).toContain('max steps');
  });

  it('a judge "rework" loops back to implement and qa, then ships after human approval', async () => {
    const choices = ['rework', 'ship'];
    const calls: string[] = [];
    const { engine, store } = engineFor(scaffold(orgFiles('true')), {
      decider: {
        decide: async () => ({ choice: choices.shift() ?? 'ship' }),
      },
      adapters: {
        mock: new MockAdapter((j) => {
          calls.push(j.nodeId);
          return { output: null, summary: '' };
        }),
      },
    });
    const s = await engine.start({ workflow: 'hello', input: {}, workspace: process.cwd() });
    expect(s.status).toBe('completed');
    expect(calls).toEqual(['analyse', 'implement', 'implement']);
    expect(s.nodes.implement?.attempts).toBe(2);
    expect(s.nodes.qa?.attempts).toBe(2);
    expect(s.nodes.judge).toMatchObject({ attempts: 2, choice: 'ship' });
    expect(s.nodes.ship).toMatchObject({ status: 'completed', attempts: 1 });
    const events = await store.read(s.runId);
    expect(events.flatMap((e) => (e.type === 'DecisionMade' ? [e.choice] : []))).toEqual([
      'rework',
      'ship',
    ]);
    expect(events.filter((e) => e.type === 'HumanResponded')).toHaveLength(1);
  });

  it('parallel human branches wait together; respond by node id finishes the run', async () => {
    const dir = scaffold({
      'org.yaml': 'organization: wc\nteams: [eng]\n',
      'teams/eng.yaml': 'team: eng\nlead: tl\nroles: [tl, analyst]\nworkflows: [par]\n',
      'roles/tl.yaml': 'role: tl\n',
      'roles/analyst.yaml': 'role: analyst\nruntime: mock\n',
      'workflows/par.yaml': [
        'workflow: par',
        'team: eng',
        'start: p',
        'nodes:',
        '  p: { type: parallel, branches: [h1, h2], join: done }',
        '  h1: { type: human, action: a1 }',
        '  h2: { type: human, action: a2 }',
        '  done: { type: task, role: analyst, instruction: fin }',
        '',
      ].join('\n'),
    });
    const { engine } = engineFor(dir, { human: new DeferHuman() });
    const waiting = await engine.start({ workflow: 'par', input: {}, workspace: process.cwd() });
    expect(waiting.status).toBe('waiting_human');
    expect(waiting.pendingHumans.map((p) => p.nodeId).sort()).toEqual(['h1', 'h2']);
    await expect(engine.respond(waiting.runId, { approved: true })).rejects.toThrow(
      /h1.*h2|h2.*h1/,
    );
    await expect(engine.respond(waiting.runId, { approved: true }, 'nope')).rejects.toThrow(
      /not waiting for a human at nope/,
    );
    const half = await engine.respond(waiting.runId, { approved: true }, 'h1');
    expect(half.status).toBe('waiting_human');
    expect(half.pendingHumans.map((p) => p.nodeId)).toEqual(['h2']);
    expect(half.nodes.done).toBeUndefined();
    const done = await engine.respond(waiting.runId, { approved: true }, 'h2');
    expect(done.status).toBe('completed');
    expect(done.nodes.done?.status).toBe('completed');
  });

  it('resume on a waiting run asks every pending human in order', async () => {
    const dir = scaffold({
      'org.yaml': 'organization: wc\nteams: [eng]\n',
      'teams/eng.yaml': 'team: eng\nlead: tl\nroles: [tl, analyst]\nworkflows: [par]\n',
      'roles/tl.yaml': 'role: tl\n',
      'roles/analyst.yaml': 'role: analyst\nruntime: mock\n',
      'workflows/par.yaml': [
        'workflow: par',
        'team: eng',
        'start: p',
        'nodes:',
        '  p: { type: parallel, branches: [h1, h2], join: done }',
        '  h1: { type: human, action: a1 }',
        '  h2: { type: human, action: a2 }',
        '  done: { type: task, role: analyst, instruction: fin }',
        '',
      ].join('\n'),
    });
    const store = new MemoryEventStore();
    const deferring = engineFor(dir, { store, human: new DeferHuman() }).engine;
    const waiting = await deferring.start({ workflow: 'par', input: {}, workspace: process.cwd() });
    expect(waiting.status).toBe('waiting_human');
    const asked: string[] = [];
    const answering = engineFor(dir, {
      store,
      human: {
        ask: async (req) => {
          asked.push(req.nodeId);
          return { approved: true };
        },
      },
    }).engine;
    const done = await answering.resume(waiting.runId);
    expect(asked).toEqual(waiting.pendingHumans.map((p) => p.nodeId));
    expect(done.status).toBe('completed');
  });

  it('a join gate that fails reworks one branch and completes when it passes', async () => {
    const dir = scaffold({
      'org.yaml': 'organization: wc\nteams: [eng]\n',
      'teams/eng.yaml': 'team: eng\nlead: tl\nroles: [tl, analyst]\nworkflows: [jg]\n',
      'roles/tl.yaml': 'role: tl\n',
      'roles/analyst.yaml': 'role: analyst\nruntime: mock\n',
      'gates/ready.yaml':
        'gate: ready\nchecks:\n  - { name: ok-file, type: code, command: "test -f ok.txt" }\n',
      'workflows/jg.yaml': [
        'workflow: jg',
        'team: eng',
        'start: p',
        'nodes:',
        '  p: { type: parallel, branches: [b1, b2], join: g }',
        '  b1: { type: task, role: analyst, instruction: b1 }',
        '  b2: { type: task, role: analyst, instruction: b2 }',
        '  g: { type: gate, gates: [ready], on_pass: h, on_fail: b1, max_retries: 1 }',
        '  h: { type: human, action: ok }',
        '',
      ].join('\n'),
    });
    const workspace = mkdtempSync(join(tmpdir(), 'ws-'));
    const calls: string[] = [];
    const { engine, store } = engineFor(dir, {
      adapters: {
        mock: new MockAdapter((j) => {
          calls.push(j.nodeId);
          // b1 creates the file the gate checks for only on its second run
          if (calls.filter((c) => c === 'b1').length === 2)
            writeFileSync(join(workspace, 'ok.txt'), 'ok');
          return { output: null, summary: '' };
        }),
      },
    });
    const s = await engine.start({ workflow: 'jg', input: {}, workspace });
    expect(s.status).toBe('completed');
    expect(calls.sort()).toEqual(['b1', 'b1', 'b2']);
    expect(s.nodes.b2?.attempts).toBe(1);
    expect(s.nodes.g).toMatchObject({ status: 'passed', attempts: 2 });
    expect(s.nodes.h?.status).toBe('completed');
    const types = (await store.read(s.runId)).map((e) => e.type);
    expect(types.filter((t) => t === 'GateFailed')).toHaveLength(1);
    expect(types.filter((t) => t === 'GatePassed')).toHaveLength(1);
  });

  it('resume on a budget-paused run requires a budget above what was spent', async () => {
    const { engine } = engineFor(scaffold(orgFiles('true')));
    const paused = await engine.start({
      workflow: 'hello',
      input: {},
      workspace: process.cwd(),
      budgetUsd: 0.15,
    });
    expect(paused.status).toBe('paused_budget');
    await expect(engine.resume(paused.runId)).rejects.toThrow(
      `run ${paused.runId} is paused on budget: pass a budgetUsd higher than ${paused.spentUsd}`,
    );
    await expect(engine.resume(paused.runId, { budgetUsd: 0.1 })).rejects.toThrow(
      /paused on budget/,
    );
    expect((await engine.state(paused.runId)).status).toBe('paused_budget');
  });

  it('cancel() aborts the running task and leaves the run cancelled', async () => {
    const dir = scaffold(orgFiles('true'));
    let seenSignal: AbortSignal | undefined;
    const adapter = new MockAdapter(async (_j, ctx) => {
      seenSignal = ctx.signal;
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, 5_000);
        ctx.signal.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new Error('aborted'));
        });
      });
      return { output: null, summary: '' };
    });
    const { engine, store } = engineFor(dir, { adapters: { mock: adapter } });
    const started = engine.start({ workflow: 'hello', input: {}, workspace: process.cwd() });
    await new Promise((r) => setTimeout(r, 50));
    const runId = (await engine.listRuns())[0]!.runId;
    const cancelled = await engine.cancel(runId, 'user');
    expect(cancelled.status).toBe('cancelled');
    expect(seenSignal?.aborted).toBe(true);
    const final = await started;
    expect(final.status).toBe('cancelled');
    expect(final.nodes.analyse?.status).toBe('failed');
    const types = (await store.read(runId)).map((e) => e.type);
    expect(types.indexOf('RunCancelled')).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('NodeFailed')).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('RunCancelled')).toBeLessThan(types.indexOf('NodeFailed'));
  });

  it('cancel() on a waiting_human run cancels it and releases the controller', async () => {
    const { engine } = engineFor(scaffold(orgFiles('true')), { human: new DeferHuman() });
    const waiting = await engine.start({ workflow: 'hello', input: {}, workspace: process.cwd() });
    expect(waiting.status).toBe('waiting_human');
    expect(engine.controllerCount()).toBe(1);
    const cancelled = await engine.cancel(waiting.runId, 'stop');
    expect(cancelled.status).toBe('cancelled');
    expect(engine.controllerCount()).toBe(0);
  });

  it('stores the resolved workflow in RunCreated and resumes from it even if the org changed', async () => {
    const dir = scaffold(orgFiles('true'));
    const { engine, store } = engineFor(dir, { human: new DeferHuman() });
    const waiting = await engine.start({ workflow: 'hello', input: {}, workspace: process.cwd() });
    const created = (await store.read(waiting.runId))[0];
    expect(created?.type === 'RunCreated' && created.workflowSnapshot?.nodes.qa).toBeTruthy();
    writeFileSync(
      join(dir, 'workflows/hello.yaml'),
      'workflow: hello\nstart: only\nnodes:\n  only: { type: human, action: x }\n',
    );
    const { engine: engine2 } = engineFor(dir, { store, human: new AutoApproveHuman() }); // same store, new org
    const done = await engine2.respond(waiting.runId, { approved: true });
    expect(done.status).toBe('completed');
    expect(done.nodes.ship?.status).toBe('completed'); // still the old workflow
  });

  it('cancels with a stall reason instead of completing when the scheduler reports a stall', async () => {
    const dir = scaffold(orgFiles('true'));
    const { engine, store } = engineFor(dir, {
      scheduler: {
        readyNodes: () => [],
        isStalled: () => ({
          stalled: true,
          reason: 'node "x" is pending but no predecessor finished after it started',
        }),
      },
    });
    const s = await engine.start({ workflow: 'hello', input: {}, workspace: process.cwd() });
    expect(s.status).toBe('cancelled');
    expect(s.error).toContain('stalled: node "x"');
    expect((await store.read(s.runId)).map((e) => e.type)).not.toContain('RunCompleted');
  });

  it('resume with a budget while waiting_human applies the new budget', async () => {
    const dir = scaffold(orgFiles('true'));
    const { engine, store } = engineFor(dir, { human: new DeferHuman() });
    const waiting = await engine.start({
      workflow: 'hello',
      input: {},
      workspace: process.cwd(),
      budgetUsd: 1,
    });
    const { engine: engine2 } = engineFor(dir, { store, human: new AutoApproveHuman() });
    const done = await engine2.resume(waiting.runId, { budgetUsd: 9 });
    expect(done.status).toBe('completed');
    expect(done.budgetUsd).toBe(9);
  });
});
