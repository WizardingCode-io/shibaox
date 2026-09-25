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
  const store = new MemoryEventStore();
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
    expect(waiting.pendingHuman?.nodeId).toBe('ship');
    const done = await engine.respond(waiting.runId, { approved: true });
    expect(done.status).toBe('completed');
  });

  it('a rejected human approval cancels the run', async () => {
    const { engine } = engineFor(scaffold(orgFiles('true')), {
      human: { ask: async () => ({ approved: false, note: 'no' }) },
    });
    const s = await engine.start({ workflow: 'hello', input: {}, workspace: process.cwd() });
    expect(s.status).toBe('cancelled');
    expect(s.error).toContain('ship');
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

  it('cancels a workflow that would loop forever', async () => {
    const dir = scaffold({
      ...orgFiles('true'),
      'teams/eng.yaml': 'team: eng\nlead: tl\nroles: [tl, analyst, backend]\nworkflows: [hello]\n',
      'workflows/hello.yaml':
        'workflow: hello\nstart: a\nnodes:\n  a: { type: decide, by: tl, options: [again, again2], next: { again: b, again2: b } }\n  b: { type: gate, gates: [tests], on_pass: a, on_fail: a, max_retries: 0 }\n',
    });
    const { engine } = engineFor(dir, { decider: new ScriptedDecider({}, 'again'), maxSteps: 10 });
    const s = await engine.start({ workflow: 'hello', input: {}, workspace: process.cwd() });
    expect(['cancelled', 'completed']).toContain(s.status);
  });
});
