import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunState, StoredEvent } from '@shibaox/core';
import type { Workflow } from '@shibaox/schemas';
import { WorkflowSchema } from '@shibaox/schemas';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { ensureVault, safeVaultPath, writeDecisionNote, writeRunNote } from '../src/index.js';

const wf = WorkflowSchema.parse({
  workflow: 'hello-feature',
  start: 'a',
  nodes: {
    a: { type: 'task', role: 'backend', next: 'j' },
    j: {
      type: 'decide',
      by: 'team-leader',
      options: ['ship', 'rework'],
      next: { ship: 'h', rework: 'a' },
    },
    h: { type: 'human', action: 'ok' },
  },
});
const at = '2026-09-26T10:00:00.000Z';
const state: RunState = {
  runId: 'abcdef1234567890',
  workflow: 'hello-feature',
  input: { spec: 'add /health' },
  workspace: '/w',
  status: 'completed',
  nodes: {
    a: { status: 'completed', attempts: 2, summary: 'added route' },
    j: { status: 'completed', attempts: 1, choice: 'ship' },
    h: { status: 'completed', attempts: 1 },
  },
  spentUsd: 0.42,
  budgetWarned: false,
  pendingHumans: [],
  lastGateReport: {
    gates: ['tests'],
    passed: true,
    checks: [
      { name: 'unit-tests', type: 'code', passed: true, skipped: false, evidence: 'exit 0' },
    ],
  },
};
const events: StoredEvent[] = [
  {
    seq: 1,
    type: 'RunCreated',
    runId: state.runId,
    at,
    workflow: 'hello-feature',
    input: state.input,
    workspace: '/w',
  },
  { seq: 2, type: 'RunCompleted', runId: state.runId, at: '2026-09-26T10:05:00.000Z' },
];

describe('vault', () => {
  it('ensureVault creates the layout', () => {
    const v = mkdtempSync(join(tmpdir(), 'vault-'));
    ensureVault(v);
    for (const d of ['00-org', '10-projects', '20-clients', '30-knowledge', '90-system'])
      expect(existsSync(join(v, d))).toBe(true);
  });
  it('writes a run note with frontmatter and wikilinks, never overwriting', () => {
    const v = mkdtempSync(join(tmpdir(), 'vault-'));
    const { path } = writeRunNote({
      vault: v,
      project: 'sample-repo',
      state,
      events,
      workflow: wf,
      adapter: 'direct',
    });
    expect(path).toBe(join(v, '10-projects', 'sample-repo', 'runs', '2026-09-26-abcdef12.md'));
    const md = readFileSync(path, 'utf8');
    expect(md.startsWith('---\ntype: run\n')).toBe(true);
    expect(md).toContain('run_id: "abcdef1234567890"');
    expect(md).toContain('spent_usd: 0.42');
    expect(md).toContain('[[sample-repo]]');
    expect(md).toContain('[[workflow-hello-feature]]');
    expect(md).toContain('[[role-backend]]');
    expect(md).toContain('added route');
    expect(md).toContain('choice: ship');
    const second = writeRunNote({
      vault: v,
      project: 'sample-repo',
      state,
      events,
      workflow: wf,
      adapter: 'direct',
    });
    expect(second.path.endsWith('-2.md')).toBe(true);
  });
  it('writes a decision note under 90-system', () => {
    const v = mkdtempSync(join(tmpdir(), 'vault-'));
    const { path } = writeDecisionNote({ vault: v, project: 'sample-repo', state, nodeId: 'j' });
    expect(path).toContain(join('90-system', 'decisions'));
    expect(readFileSync(path, 'utf8')).toContain('ship');
  });
  it('refuses paths outside the vault', () => {
    const v = mkdtempSync(join(tmpdir(), 'vault-'));
    expect(() => safeVaultPath(v, '../x.md')).toThrow(/escapes vault/);
  });
  it('rejects a run note project that would escape the vault and creates nothing', () => {
    const v = mkdtempSync(join(tmpdir(), 'vault-'));
    expect(() =>
      writeRunNote({
        vault: v,
        project: '../sibling',
        state,
        events,
        workflow: wf,
        adapter: 'direct',
      }),
    ).toThrow(/invalid project/);
    expect(existsSync(join(v, '00-org'))).toBe(false);
    expect(existsSync(join(v, '10-projects'))).toBe(false);
  });
  it('rejects a decision note nodeId that would escape the vault and creates nothing', () => {
    const v = mkdtempSync(join(tmpdir(), 'vault-'));
    expect(() =>
      writeDecisionNote({
        vault: v,
        project: 'sample-repo',
        state,
        nodeId: '../../../../tmp/pwned',
      }),
    ).toThrow(/invalid nodeId/);
    expect(existsSync(join(v, '90-system'))).toBe(false);
  });
  it('rejects a decision note project that would escape the vault and creates nothing', () => {
    const v = mkdtempSync(join(tmpdir(), 'vault-'));
    expect(() =>
      writeDecisionNote({ vault: v, project: '../sibling', state, nodeId: 'j' }),
    ).toThrow(/invalid project/);
    expect(existsSync(join(v, '00-org'))).toBe(false);
  });
  it('quotes frontmatter scalars so special characters round-trip as valid YAML', () => {
    const v = mkdtempSync(join(tmpdir(), 'vault-'));
    const weirdName = 'demo: "v2"\nrelease';
    const weird: Workflow = {
      workflow: weirdName,
      start: 'a',
      nodes: {
        a: { type: 'task', role: 'backend', next: 'j' },
        j: {
          type: 'decide',
          by: 'team-leader',
          options: ['ship', 'rework'],
          next: { ship: 'h', rework: 'a' },
        },
        h: { type: 'human', action: 'ok' },
      },
    };
    const { path } = writeRunNote({
      vault: v,
      project: 'sample-repo',
      state,
      events,
      workflow: weird,
      adapter: 'direct',
    });
    const md = readFileSync(path, 'utf8');
    const fmMatch = md.match(/^---\n([\s\S]*?)\n---\n/);
    expect(fmMatch).toBeTruthy();
    const fm = parseYaml(fmMatch?.[1] ?? '');
    expect(fm.workflow).toBe(weirdName);
    expect(fm.nodes).toEqual(['a', 'j', 'h']);
  });
  it('uses a deterministic date for decision notes, not wall-clock, so repeats append -2', () => {
    const v = mkdtempSync(join(tmpdir(), 'vault-'));
    const fixedAt = '2020-01-02T03:04:05.000Z';
    const first = writeDecisionNote({
      vault: v,
      project: 'sample-repo',
      state,
      nodeId: 'j',
      at: fixedAt,
    });
    expect(first.path.endsWith('2020-01-02-abcdef12-j.md')).toBe(true);
    const second = writeDecisionNote({
      vault: v,
      project: 'sample-repo',
      state,
      nodeId: 'j',
      at: fixedAt,
    });
    expect(second.path.endsWith('2020-01-02-abcdef12-j-2.md')).toBe(true);
  });
  it("derives the decision date from the node's own DecisionMade event when at is omitted", () => {
    const v = mkdtempSync(join(tmpdir(), 'vault-'));
    const decisionEvents: StoredEvent[] = [
      ...events,
      {
        seq: 3,
        type: 'DecisionMade',
        runId: state.runId,
        nodeId: 'j',
        at: '2021-06-07T00:00:00.000Z',
        choice: 'ship',
      },
    ];
    const { path } = writeDecisionNote({
      vault: v,
      project: 'sample-repo',
      state,
      nodeId: 'j',
      events: decisionEvents,
    });
    expect(path.endsWith('2021-06-07-abcdef12-j.md')).toBe(true);
  });
});
