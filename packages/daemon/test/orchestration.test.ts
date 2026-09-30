import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryNotes } from '@wizardingcode/shibaox-memory';
import { RoleSchema } from '@wizardingcode/shibaox-schemas';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { memoryTools, orchestrationTools, toolsForRole } from '../src/runs/orchestration.js';
import { profileFor } from '../src/runs/profile.js';

const sample = fileURLToPath(new URL('../../../examples/sample-repo', import.meta.url));

describe('orchestrationTools', () => {
  const started: [string, string][] = [];
  const tools = () =>
    orchestrationTools({
      runId: 'parent',
      current: 'chat',
      workflows: [
        { name: 'chat', description: 'Talk with the assistant' },
        { name: 'hello-feature', description: 'Analyse, implement, test, judge, ship.' },
      ],
      startWorkflow: async (workflow, request) => {
        started.push([workflow, request]);
        return { runId: 'child-1' };
      },
    });
  it('start_workflow lists the other workflows in its description', () => {
    const t = tools().find((x) => x.name === 'start_workflow');
    expect(t?.description).toContain('hello-feature — Analyse, implement, test, judge, ship.');
    expect(t?.description).not.toContain('chat —');
  });
  it('start_workflow submits a child run and refuses unknown workflows without throwing', async () => {
    const t = tools().find((x) => x.name === 'start_workflow');
    expect(await t?.execute({ workflow: 'hello-feature', request: 'add /health' })).toEqual({
      runId: 'child-1',
      workflow: 'hello-feature',
      status: 'queued',
    });
    expect(started).toEqual([['hello-feature', 'add /health']]);
    expect(await t?.execute({ workflow: 'nope', request: 'x' })).toEqual({
      error: 'workflow "nope" is not defined in the org (available: hello-feature)',
    });
    expect(await t?.execute({ workflow: 'chat', request: 'x' })).toMatchObject({
      error: expect.stringContaining('chat'),
    });
  });
});

describe('toolsForRole', () => {
  const orchestration = [
    { name: 'start_workflow', description: '', input: z.object({}), execute: async () => ({}) },
  ];
  const memory = [
    { name: 'remember', description: '', input: z.object({}), execute: async () => ({}) },
  ];
  const role = (capabilities: string[]) => RoleSchema.parse({ role: 'r', capabilities });
  it('follows the role capabilities and drops start_workflow on event turns', () => {
    const names = (r: ReturnType<typeof role>, input: Record<string, unknown>) =>
      toolsForRole(r, input, { orchestration, memory }).map((t) => t.name);
    expect(names(role(['orchestrate', 'memory']), { spec: 'olá' })).toEqual([
      'start_workflow',
      'remember',
    ]);
    expect(names(role(['orchestrate', 'memory']), { spec: 'x', event: true })).toEqual([
      'remember',
    ]);
    expect(names(role(['memory']), { spec: 'x' })).toEqual(['remember']);
    expect(names(role([]), { spec: 'x' })).toEqual([]);
  });
});

describe('memoryTools', () => {
  it('remember then recall round-trip on a vault', async () => {
    const notes = new MemoryNotes({ vault: mkdtempSync(join(tmpdir(), 'v-')), project: 'p' });
    const t = memoryTools(notes);
    expect(t.map((x) => x.name)).toEqual(['remember', 'recall']);
    expect(await t[0]?.execute({ scope: 'user', text: 'uses pnpm' })).toEqual({
      ok: true,
      scope: 'user',
    });
    expect(await t[1]?.execute({ query: 'pnpm' })).toEqual({
      matches: [{ scope: 'user', line: expect.stringContaining('uses pnpm') }],
    });
    expect(await t[0]?.execute({ scope: 'other', text: 'x' })).toMatchObject({
      error: expect.any(String),
    });
  });
});

describe('profileFor', () => {
  it('profiles the project, writes the vault note and caches by path', () => {
    const vault = mkdtempSync(join(tmpdir(), 'v-'));
    const p = profileFor(sample, { vault, cacheMs: 60_000 });
    expect(p.summary).toContain('files');
    expect(p.stack).toContain('JavaScript');
    const note = join(vault, '10-projects', 'sample-repo', 'profile.md');
    expect(existsSync(note)).toBe(true);
    expect(readFileSync(note, 'utf8')).toContain('type: project-profile');
    expect(profileFor(sample, { vault, cacheMs: 60_000 })).toBe(p);
    expect(profileFor(sample, { vault, cacheMs: 0 })).not.toBe(p);
  });
});

describe('orchestration: seeing and steering the dispatched runs', () => {
  const calls: string[] = [];
  const tools = () =>
    orchestrationTools({
      runId: 'parent',
      current: 'chat',
      workflows: [{ name: 'hello-feature' }],
      startWorkflow: async (_w, _r, o) => {
        calls.push(`start:${JSON.stringify(o?.outputSchema ?? null)}`);
        return { runId: 'child-1' };
      },
      listRuns: async () => [
        {
          runId: 'child-1',
          workflow: 'hello-feature',
          status: 'running',
          spentUsd: 0.1,
          createdAt: 't',
          updatedAt: 't',
          parentRunId: 'parent',
        },
        {
          runId: 'other',
          workflow: 'x',
          status: 'running',
          spentUsd: 0,
          createdAt: 't',
          updatedAt: 't',
          parentRunId: 'someone-else',
        },
      ],
      runStatus: async (id) =>
        ({
          runId: id,
          status: 'running',
          nodes: { implement: { status: 'running', attempts: 1, approvals: {} } },
          pendingHumans: [],
          pendingApprovals: [],
          spentUsd: 0.1,
          error: undefined,
        }) as never,
      steerRun: async (id, note) => {
        calls.push(`steer:${id}:${note}`);
        return { ok: true };
      },
      cancelRun: async (id) => {
        calls.push(`cancel:${id}`);
        return { ok: true };
      },
    });
  it('list_runs shows the runs dispatched anywhere in this conversation (each turn is a run), not the turns themselves', async () => {
    const list = tools().find((t) => t.name === 'list_runs');
    const r = (await list?.execute({})) as { runs: { runId: string }[] };
    expect(r.runs.map((x) => x.runId)).toEqual(['child-1']);
  });
  it('on an event turn the orchestrator keeps list/status/steer/cancel but never start_workflow', () => {
    const role = RoleSchema.parse({ role: 'assistant', capabilities: ['orchestrate'] });
    const names = toolsForRole(role, { event: true }, { orchestration: tools(), memory: [] }).map(
      (t) => t.name,
    );
    expect(names).toEqual(['list_runs', 'run_status', 'steer_run', 'cancel_run']);
  });
  it('list_runs shows only the runs this run dispatched; run_status tells where one is', async () => {
    const list = tools().find((t) => t.name === 'list_runs');
    const r = (await list?.execute({})) as { runs: { runId: string }[] };
    expect(r.runs.map((x) => x.runId)).toEqual(['child-1']);
    const status = tools().find((t) => t.name === 'run_status');
    const st = (await status?.execute({ runId: 'child-1' })) as {
      status: string;
      nodes: unknown[];
    };
    expect(st.status).toBe('running');
    expect(JSON.stringify(st.nodes)).toContain('implement');
    expect(await status?.execute({ runId: 'other' })).toMatchObject({
      error: expect.stringMatching(/not one of your runs/),
    });
  });
  it('steer_run and cancel_run act on own children only; start_workflow carries an output schema', async () => {
    const steer = tools().find((t) => t.name === 'steer_run');
    expect(await steer?.execute({ runId: 'child-1', note: 'use pnpm' })).toMatchObject({
      ok: true,
    });
    expect(await steer?.execute({ runId: 'other', note: 'x' })).toMatchObject({
      error: expect.stringMatching(/not one of your runs/),
    });
    expect(await steer?.execute({ runId: 'child-1', note: '' })).toMatchObject({
      error: expect.stringMatching(/note/),
    });
    const cancel = tools().find((t) => t.name === 'cancel_run');
    expect(await cancel?.execute({ runId: 'child-1' })).toMatchObject({ ok: true });
    const start = tools().find((t) => t.name === 'start_workflow');
    await start?.execute({
      workflow: 'hello-feature',
      request: 'do it',
      output_schema: {
        type: 'object',
        required: ['verdict'],
        properties: { verdict: { type: 'string' } },
      },
    });
    expect(
      await start?.execute({ workflow: 'hello-feature', request: 'do it', output_schema: 'nope' }),
    ).toMatchObject({ error: expect.stringMatching(/output_schema/) });
    expect(calls).toEqual([
      'steer:child-1:use pnpm',
      'cancel:child-1',
      'start:{"type":"object","required":["verdict"],"properties":{"verdict":{"type":"string"}}}',
    ]);
  });
});
