import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeQuery, msg } from '@wizardingcode/shibaox-adapter-claude-code/testing';
import { MemoryEventStore } from '@wizardingcode/shibaox-core';
import { startFakeJev } from '@wizardingcode/shibaox-jev/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { DaemonClient } from '../src/client.js';
import { Daemon } from '../src/daemon.js';
import { homePaths } from '../src/home.js';

const tmp: string[] = [];
const daemons: Daemon[] = [];
const fakes: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop({ force: true }).catch(() => undefined);
  for (const f of fakes.splice(0)) await f.close();
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('Jev routing through the daemon', () => {
  it('a chat turn is routed: GET /decisions lists the router decisions, the TypeSafe card shows the last one', async () => {
    const jev = await startFakeJev(() => ({
      intent: { type: 'choice', choice: 'media', confidence: 0.98, probabilities: {} },
      tier: { type: 'choice', choice: 'cheap', confidence: 0.9, probabilities: {} },
      risky: { type: 'noul', noul: 0.02 },
    }));
    fakes.push(jev);
    const dir = mkdtempSync(join(tmpdir(), 'routed-'));
    tmp.push(dir);
    const home = homePaths({ SHIBAOX_HOME: join(dir, 'home') });
    const logs: string[] = [];
    const daemon = new Daemon({
      discovery: false,
      home,
      store: new MemoryEventStore(),
      channels: [],
      env: { TYPESAFE_API_KEY: 'ts-key-xyz', SHIBAOX_JEV_BASE_URL: jev.baseURL },
      log: (l) => logs.push(l),
      version: '9.9.9',
      vault: join(dir, 'vault'),
      // the default org on the Claude subscription (a mock turn is never routed)
      claudeInstalled: true,
      queryFn: fakeQuery(() => [msg.init(), msg.success('a cat')]),
    });
    daemons.push(daemon);
    await daemon.start();
    const client = new DaemonClient(home.socket);
    const org = (await client.defaultOrg()).root;
    const { runId } = await client.submitRun({
      orgRoot: org,
      project: org,
      workflow: 'chat',
      input: 'draw me a cat',
      workspace: 'inplace',
    });
    for (let i = 0; i < 200; i++) {
      const s = await client.getRun(runId);
      if (['completed', 'failed'].includes(s.status)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const state = await client.getRun(runId);
    expect(state.route).toMatchObject({ intent: 'media', tier: 'cheap', by: 'jev' });
    const view = await client.decisions();
    expect(view.decider).toMatchObject({ kind: 'jev', ref: 'jev-latest' });
    expect(view.decisions.filter((d) => d.runId === runId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeId: 'router', choice: 'media', by: 'jev' }),
        expect.objectContaining({ nodeId: 'router:tier', choice: 'cheap', by: 'jev' }),
      ]),
    );
    const card = (await client.plugins()).find((p) => p.id === 'typesafe');
    expect(card?.status).toBe('ready');
    expect(card?.checks.find((c) => c.label === 'Jev routes requests')).toEqual({
      label: 'Jev routes requests',
      ok: true,
      detail: 'last: media 0.98',
    });
    expect(logs.join('\n')).not.toContain('ts-key-xyz');
  });
});
