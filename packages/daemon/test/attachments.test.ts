import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

async function start() {
  const dir = mkdtempSync(join(tmpdir(), 'att-'));
  tmp.push(dir);
  scaffoldOrg(dir);
  const home = homePaths({ SHIBAOX_HOME: join(dir, 'home') });
  const d = new Daemon({
    discovery: false,
    home,
    store: new MemoryEventStore(),
    channels: [],
    env: {},
    log: () => {},
    version: '9.9.9',
    vault: join(dir, 'vault'),
  });
  daemons.push(d);
  await d.start();
  return { dir, client: new DaemonClient(home.socket), project: join(dir, 'org') };
}
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

describe('attachments of a turn', () => {
  it('land under attachments/ in the workspace, safely named, listed with the run, and named in the message', async () => {
    const { client, project } = await start();
    const { runId } = await client.submitRun({
      orgRoot: project,
      project,
      workflow: 'hello-feature',
      input: 'Read the data',
      adapter: 'mock',
      workspace: 'inplace',
      attachments: [
        { name: 'clientes mock.csv', content: b64('a,b\n1,2\n'), mime: 'text/csv' },
        { name: '../../../etc/passwd', content: b64('x') },
        { name: 'clientes mock.csv', content: b64('c,d\n') },
      ],
    });
    for (let i = 0; i < 100; i++) {
      const s = await client.getRun(runId);
      if (['completed', 'failed', 'waiting_human'].includes(s.status)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(readFileSync(join(project, 'attachments', 'clientes mock.csv'), 'utf8')).toBe(
      'a,b\n1,2\n',
    );
    expect(readFileSync(join(project, 'attachments', 'passwd'), 'utf8')).toBe('x');
    expect(readFileSync(join(project, 'attachments', 'clientes mock-2.csv'), 'utf8')).toBe('c,d\n');
    const state = await client.getRun(runId);
    expect(String(state.input.spec)).toContain('[Attached files]');
    expect(String(state.input.spec)).toContain('attachments/clientes mock.csv (8 B, text/csv)');
    const files = await client.files(runId);
    expect(files.files.map((f) => f.path)).toEqual(
      expect.arrayContaining(['attachments/clientes mock.csv', 'attachments/passwd']),
    );
  });
  it('refuses more than the cap, and a name that is empty or a directory', async () => {
    const { client, project } = await start();
    const common = {
      orgRoot: project,
      project,
      workflow: 'hello-feature',
      input: 'x',
      adapter: 'mock' as const,
      workspace: 'inplace' as const,
    };
    await expect(
      client.submitRun({
        ...common,
        attachments: [
          { name: 'big.bin', content: Buffer.alloc(26 * 1024 * 1024).toString('base64') },
        ],
      }),
    ).rejects.toMatchObject({ status: 413 });
    await expect(
      client.submitRun({ ...common, attachments: [{ name: '', content: b64('x') }] }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
