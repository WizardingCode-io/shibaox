import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AutoApproveHuman, DeferHuman } from '@wizardingcode/shibaox-core';
import { describe, expect, it } from 'vitest';
import { resumeRun, runWorkflow } from '../src/inline.js';
import { scaffoldOrg } from '../src/templates.js';

const sample = fileURLToPath(new URL('../../../examples/sample-repo', import.meta.url));

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-'));
  scaffoldOrg(dir);
  const project = join(dir, 'project');
  cpSync(sample, project, { recursive: true });
  // An empty env keeps these runs hermetic: no provider or Jev key leaks in from the shell.
  return { org: join(dir, 'org'), project, db: join(dir, 'events.db'), env: {} };
}

describe('shibaox run (mock adapter)', () => {
  it('completes hello-feature against the sample repo', async () => {
    const { org, project, db, env } = setup();
    const state = await runWorkflow('hello-feature', {
      org,
      project,
      db,
      env,
      input: 'add /health',
      adapter: 'mock',
      human: new AutoApproveHuman(),
      log: () => {},
    });
    expect(state.status).toBe('completed');
    expect(state.nodes.qa?.status).toBe('passed');
    expect(state.nodes.judge?.choice).toBe('ship');
    expect(state.lastGateReport?.checks.map((c) => c.type)).toEqual(['tests']); // the org template detects the project's runner
  });
  it('chat answers in one node: no team gates, no push', async () => {
    const { org, project, db, env } = setup();
    const state = await runWorkflow('chat', {
      org,
      project,
      db,
      env,
      input: 'olá',
      adapter: 'mock',
      human: new AutoApproveHuman(),
      log: () => {},
    });
    expect(state.status).toBe('completed');
    expect(Object.keys(state.nodes)).toEqual(['reply']);
    expect(state.lastGateReport).toBeUndefined();
  });
  it('fails after retries when the sample tests are broken', async () => {
    const { org, project, db, env } = setup();
    writeFileSync(
      join(project, 'math.test.js'),
      "import { test } from 'node:test'; test('x', () => { throw new Error('broken'); });\n",
    );
    const state = await runWorkflow('hello-feature', {
      org,
      project,
      db,
      env,
      input: 'x',
      adapter: 'mock',
      human: new AutoApproveHuman(),
      log: () => {},
    });
    expect(state.status).toBe('failed');
    expect(state.error).toContain('gate failed after 3 attempts');
    expect(state.lastGateReport?.checks[0]?.evidence).toContain('broken');
  });
  it('pauses on a tiny budget', async () => {
    const { org, project, db, env } = setup();
    const state = await runWorkflow('hello-feature', {
      org,
      project,
      db,
      env,
      input: 'x',
      adapter: 'mock',
      budget: 0.000001,
      human: new AutoApproveHuman(),
      log: () => {},
    });
    expect(state.status).toBe('paused_budget');
  });
  it('defers the human when not interactive, then resume approves and completes', async () => {
    const { org, project, db, env } = setup();
    const waiting = await runWorkflow('hello-feature', {
      org,
      project,
      db,
      env,
      input: 'add /health',
      adapter: 'mock',
      human: new DeferHuman(),
      log: () => {},
    });
    expect(waiting.status).toBe('waiting_human');
    expect(waiting.pendingHumans.map((p) => p.nodeId)).toEqual(['ship']);
    const stillWaiting = await resumeRun(waiting.runId, {
      org,
      db,
      env,
      human: new DeferHuman(),
      log: () => {},
    });
    expect(stillWaiting.status).toBe('waiting_human');
    const done = await resumeRun(waiting.runId, {
      org,
      db,
      env,
      human: new AutoApproveHuman(),
      log: () => {},
    });
    expect(done.status).toBe('completed');
    expect(done.nodes.ship?.status).toBe('completed');
  });
  it('uses the org per-run budget when --budget is not given', async () => {
    const { org, project, db, env } = setup();
    const state = await runWorkflow('hello-feature', {
      org,
      project,
      db,
      env,
      input: 'x',
      adapter: 'mock',
      human: new AutoApproveHuman(),
      log: () => {},
    });
    expect(state.budgetUsd).toBe(5);
  });
  it('rejects a project path that does not exist or is not a directory', async () => {
    const { org, project, db } = setup();
    const missing = join(project, 'nope');
    await expect(
      runWorkflow('hello-feature', { org, project: missing, db, input: 'x', adapter: 'mock' }),
    ).rejects.toThrow(`project path not found: ${missing}`);
    const file = join(project, 'math.test.js');
    await expect(
      runWorkflow('hello-feature', { org, project: file, db, input: 'x', adapter: 'mock' }),
    ).rejects.toThrow(`project path not found: ${file}`);
  });
});
