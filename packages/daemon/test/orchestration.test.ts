import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryNotes } from '@shibaox/memory';
import { RoleSchema } from '@shibaox/schemas';
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
