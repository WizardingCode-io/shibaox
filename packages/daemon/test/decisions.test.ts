import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryEventStore } from '@wizardingcode/shibaox-core';
import { afterEach, describe, expect, it } from 'vitest';
import { DaemonClient } from '../src/client.js';
import { Daemon } from '../src/daemon.js';
import { homePaths } from '../src/home.js';
import { scaffoldOrg } from '../src/templates.js';

const tmp: string[] = [];
const daemons: Daemon[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop({ force: true }).catch(() => undefined);
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('GET /decisions', () => {
  it('says who decides and lists the latest decisions across runs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'decisions-'));
    tmp.push(dir);
    scaffoldOrg(dir);
    const home = homePaths({ SHIBAOX_HOME: join(dir, 'home') });
    const daemon = new Daemon({
      discovery: false,
      home,
      store: new MemoryEventStore(),
      channels: [],
      env: {},
      log: () => {},
      version: '9.9.9',
      vault: join(dir, 'vault'),
    });
    daemons.push(daemon);
    await daemon.start();
    const client = new DaemonClient(home.socket);
    const before = await client.decisions();
    // the scaffold's decision tier is Jev's typed API (jev-latest), which has no key here
    expect(before.decider).toMatchObject({ kind: 'none', ref: 'jev-latest', usable: false });
    expect(before.decider.reason).toMatch(/TYPESAFE_API_KEY/);
    expect(before.decider.reason).toMatch(/always pick ship/);
    expect(before.decisions).toEqual([]);
    const { runId } = await client.submitRun({
      orgRoot: join(dir, 'org'),
      project: join(dir, 'org'),
      workflow: 'hello-feature',
      input: 'add /health',
      adapter: 'mock',
      workspace: 'inplace',
    });
    for (let i = 0; i < 200; i++) {
      const s = await client.getRun(runId);
      if (['completed', 'failed', 'waiting_human'].includes(s.status)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const after = await client.decisions();
    expect(after.decisions[0]).toMatchObject({
      runId,
      nodeId: 'judge',
      choice: 'ship',
      by: 'scripted',
    });
    expect(typeof after.decisions[0]?.at).toBe('string');
  });
});
