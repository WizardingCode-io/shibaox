import { appendFileSync, cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AutoApproveHuman, MemoryEventStore } from '@shibaox/core';
import { SqliteEventStore } from '@shibaox/persistence-sqlite';
import type { ProviderEntry } from '@shibaox/providers';
import { loadOrg } from '@shibaox/schemas';
import { describe, expect, it } from 'vitest';
import { scaffoldOrg } from '../src/commands/init.js';
import { resumeRun } from '../src/commands/resume.js';
import { runWorkflow } from '../src/commands/run.js';
import { buildRuntime } from '../src/wiring.js';

const sample = fileURLToPath(new URL('../../../examples/sample-repo', import.meta.url));

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'wiring-'));
  scaffoldOrg(dir);
  const project = join(dir, 'project');
  cpSync(sample, project, { recursive: true });
  return { org: join(dir, 'org'), project, db: join(dir, 'events.db') };
}

const unpricedFake: ProviderEntry = {
  id: 'fake',
  name: 'Fake',
  kind: 'openai-compatible',
  base_url: 'http://127.0.0.1:9/v1',
  auth: { type: 'none' },
  models: ['m'],
  pricing: {},
  verify: false,
};

async function runCount(db: string): Promise<number> {
  const store = new SqliteEventStore(db);
  try {
    return (await store.listRuns()).length;
  } finally {
    store.close();
  }
}

describe('adapter selection and start checks', () => {
  it('run --adapter direct with an unconfigured strong tier rejects before any event', async () => {
    const { org, project, db } = setup();
    const lines: string[] = [];
    await expect(
      runWorkflow('hello-feature', {
        org,
        project,
        db,
        input: 'x',
        adapter: 'direct',
        env: {},
        human: new AutoApproveHuman(),
        log: (l) => lines.push(l),
      }),
    ).rejects.toThrow(/^cannot start: role "backend" → provider "anthropic" is not configured/);
    expect(await runCount(db)).toBe(0);
    expect(lines).toContain('adapter=direct');
    expect(lines).toContain('  analyst → ollama/llama3.2');
  });

  it('a plain run uses mock even with provider keys in the environment', async () => {
    const { org, project, db } = setup();
    const lines: string[] = [];
    const state = await runWorkflow('hello-feature', {
      org,
      project,
      db,
      input: 'x',
      env: { ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k' },
      human: new AutoApproveHuman(),
      log: (l) => lines.push(l),
    });
    expect(lines[0]).toBe('adapter=mock');
    expect(state.status).toBe('completed');
    expect(state.nodes.implement?.output).toEqual({
      instruction: 'Implement the request. Keep tests green.',
    });
    expect(state.nodes.judge?.choice).toBe('ship');
  });

  it('adapter: direct in org.yaml selects direct (and its start checks)', async () => {
    const { org, project, db } = setup();
    appendFileSync(join(org, 'org.yaml'), 'adapter: direct\n');
    await expect(
      runWorkflow('hello-feature', { org, project, db, input: 'x', env: {}, log: () => {} }),
    ).rejects.toThrow(/cannot start: role "backend"/);
    expect(await runCount(db)).toBe(0);
    // --adapter overrides org.yaml
    const state = await runWorkflow('hello-feature', {
      org,
      project,
      db,
      input: 'x',
      adapter: 'mock',
      env: {},
      human: new AutoApproveHuman(),
      log: () => {},
    });
    expect(state.status).toBe('completed');
  });

  it('resume applies the same rules and logs the adapter', async () => {
    const { org, project, db } = setup();
    const waiting = await runWorkflow('hello-feature', {
      org,
      project,
      db,
      input: 'x',
      adapter: 'mock',
      env: {},
      log: () => {},
      human: { ask: async () => ({ deferred: true }) },
    });
    expect(waiting.status).toBe('waiting_human');
    await expect(
      resumeRun(waiting.runId, { org, db, adapter: 'direct', env: {}, log: () => {} }),
    ).rejects.toThrow(/cannot start: role "backend"/);
    const lines: string[] = [];
    const done = await resumeRun(waiting.runId, {
      org,
      db,
      env: {},
      human: new AutoApproveHuman(),
      log: (l) => lines.push(l),
    });
    expect(lines[0]).toBe('adapter=mock');
    expect(done.status).toBe('completed');
  });

  it('warns that a budget cannot be enforced for unpriced direct models', () => {
    const { org: orgDir } = setup();
    const org = loadOrg(orgDir);
    org.models.tiers.strong = 'fake/m';
    org.models.tiers.cheap = 'fake/m';
    const common = {
      org,
      store: new MemoryEventStore(),
      human: new AutoApproveHuman(),
      log: () => {},
      adapter: 'direct' as const,
      workflow: org.workflows['hello-feature'],
      env: {},
      extraProviders: [unpricedFake],
    };
    const warned = buildRuntime({ ...common, budgetUsd: 5 }).warnings;
    expect(warned).toContain('model "fake/m" has no pricing: budget cannot be enforced for it');
    const noBudget = buildRuntime(common).warnings;
    expect(noBudget.some((w) => w.includes('no pricing'))).toBe(false);
  });
});
