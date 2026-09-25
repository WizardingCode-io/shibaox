import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutoApproveHuman } from '@shibaox/core';
import { describe, expect, it } from 'vitest';
import { scaffoldOrg } from '../src/commands/init.js';
import { runWorkflow } from '../src/commands/run.js';

const sample = new URL('../../../examples/sample-repo', import.meta.url).pathname;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-'));
  scaffoldOrg(dir);
  const project = join(dir, 'project');
  cpSync(sample, project, { recursive: true });
  return { org: join(dir, 'org'), project, db: join(dir, 'events.db') };
}

describe('shibaox run (mock adapter)', () => {
  it('completes hello-feature against the sample repo', async () => {
    const { org, project, db } = setup();
    const state = await runWorkflow('hello-feature', {
      org,
      project,
      db,
      input: 'add /health',
      adapter: 'mock',
      human: new AutoApproveHuman(),
      log: () => {},
    });
    expect(state.status).toBe('completed');
    expect(state.nodes.qa?.status).toBe('passed');
    expect(state.nodes.judge?.choice).toBe('ship');
  });
  it('fails after retries when the sample tests are broken', async () => {
    const { org, project, db } = setup();
    writeFileSync(
      join(project, 'math.test.js'),
      "import { test } from 'node:test'; test('x', () => { throw new Error('broken'); });\n",
    );
    const state = await runWorkflow('hello-feature', {
      org,
      project,
      db,
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
    const { org, project, db } = setup();
    const state = await runWorkflow('hello-feature', {
      org,
      project,
      db,
      input: 'x',
      adapter: 'mock',
      budget: 0.000001,
      human: new AutoApproveHuman(),
      log: () => {},
    });
    expect(state.status).toBe('paused_budget');
  });
});
