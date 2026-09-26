import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createTestRenderer } from '@opentui/core/testing';
import { testRender } from '@opentui/react/test-utils';
import type { Envelope, SubmitRequest } from '@shibaox/daemon';
import { scaffoldOrg } from '@shibaox/daemon';
import { runStream } from '../src/app.js';
import { loadPrefs } from '../src/prefs.js';
import { FakeDaemonClient } from '../src/testing/fake-client.js';
import { NewRunForm } from '../src/ui/NewRunForm.js';

const run = (runId: string, status = 'running') =>
  ({
    runId,
    workflow: 'hello-feature',
    status,
    createdAt: 'x',
    updatedAt: 'x',
    spentUsd: 0.1,
  }) as never;
const state = (runId: string, status = 'running') =>
  ({
    runId,
    workflow: 'hello-feature',
    status,
    nodes: {},
    spentUsd: 0.1,
    pendingHumans: [],
    pendingApprovals: [],
  }) as never;
const frame = (
  runId: string,
  kind: 'run' | 'runtime' | 'end',
  payload: Record<string, unknown>,
  seq = 1,
): Envelope =>
  ({
    kind,
    seq,
    cursor: `${seq}:${seq}`,
    ...(kind === 'end'
      ? payload
      : {
          event:
            kind === 'run'
              ? { runId, at: 'x', seq, ...payload }
              : { runId, nodeId: 'impl', seq, at: 'x', event: payload },
        }),
  }) as unknown as Envelope;
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

describe('runStream (OpenTUI)', () => {
  test('follows a run through tool calls to completion and resolves 0', async () => {
    const client = new FakeDaemonClient();
    client.runs = [run('r1')];
    client.states.set('r1', state('r1'));
    const setup = await createTestRenderer({ width: 100, height: 24 });
    try {
      const done = runStream(client, 'r1', {
        home: '/tmp/shx-home',
        renderer: setup.renderer,
        env: { SHIBAOX_NO_MOTION: '1' },
      });
      await settle();
      client.pushFrame('r1', frame('r1', 'run', { type: 'NodeStarted', nodeId: 'impl' }));
      client.pushFrame(
        'r1',
        frame(
          'r1',
          'runtime',
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.ts' } },
          2,
        ),
      );
      client.pushFrame(
        'r1',
        frame(
          'r1',
          'runtime',
          { type: 'tool_result', id: 't1', name: 'Read', output: 'ok', durationMs: 7 },
          3,
        ),
      );
      await settle();
      await setup.renderOnce();
      const f = setup.captureCharFrame();
      expect(f).toContain('── impl ──');
      expect(f).toContain('> Read');
      expect(f).toContain('7 ms');
      expect(f).toContain('done');
      client.states.set('r1', state('r1', 'completed'));
      client.pushFrame('r1', frame('r1', 'end', { status: 'completed' }, 9));
      expect(await done).toEqual({ code: 0 });
    } finally {
      setup.renderer.destroy();
    }
  });

  test('a finished run replays its history; failed resolves 2; abort says it keeps running', async () => {
    const client = new FakeDaemonClient();
    client.runs = [run('r4', 'failed')];
    client.states.set('r4', state('r4', 'failed'));
    client.history.set('r4', [
      frame('r4', 'run', { type: 'NodeStarted', nodeId: 'analyse' }, 1),
      frame('r4', 'run', { type: 'NodeStarted', nodeId: 'implement' }, 2),
      frame('r4', 'end', { status: 'failed' }, 3),
    ]);
    let setup = await createTestRenderer({ width: 100, height: 24 });
    try {
      const r = await runStream(client, 'r4', {
        home: '/tmp/shx-home',
        renderer: setup.renderer,
        env: {},
      });
      expect(r).toEqual({ code: 2 });
      const seen = client.calls.filter((c) => c.method === 'getRun');
      expect(seen.length).toBeGreaterThan(0);
    } finally {
      setup.renderer.destroy();
    }
    client.runs = [run('r5')];
    client.states.set('r5', state('r5'));
    setup = await createTestRenderer({ width: 100, height: 24 });
    try {
      const ac = new AbortController();
      const p = runStream(client, 'r5', {
        home: '/tmp/shx-home',
        renderer: setup.renderer,
        env: {},
        signal: ac.signal,
      });
      await settle();
      ac.abort();
      const r = await p;
      expect(r.code).toBe(0);
      expect(r.message).toContain('keeps running');
    } finally {
      setup.renderer.destroy();
    }
  });
});

describe('NewRunForm (OpenTUI)', () => {
  test('defaults org to ./org, lists workflows, submits the fields and remembers prefs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tui-form-'));
    scaffoldOrg(dir);
    const home = join(dir, 'home');
    const submitted: SubmitRequest[] = [];
    const setup = await testRender(
      <NewRunForm
        cwd={dir}
        home={home}
        debounceMs={0}
        onSubmit={async (req) => {
          submitted.push(req);
          return 'run-1';
        }}
        onCancel={() => {}}
        onDone={() => {}}
      />,
      { width: 100, height: 24 },
    );
    // every key needs a re-render before the next one (focus moves between inputs)
    const flush = async () => {
      await settle(20);
      await setup.renderOnce();
      await settle(20);
      await setup.renderOnce();
    };
    const tab = async () => {
      await setup.mockInput.pressTab();
      await flush();
    };
    const type = async (text: string) => {
      await setup.mockInput.typeText(text);
      await flush();
    };
    try {
      await flush();
      let f = setup.captureCharFrame();
      expect(f).toContain(join(basename(dir), 'org')); // the input scrolls long values
      expect(f).toContain('hello-feature');
      await tab(); // project
      await tab(); // workflow
      await tab(); // input
      await type('add /health');
      await setup.mockInput.pressEnter();
      await flush();
      expect(submitted).toEqual([
        {
          orgRoot: join(dir, 'org'),
          project: dir,
          workflow: 'hello-feature',
          input: 'add /health',
          adapter: 'mock',
          workspace: undefined,
          budgetUsd: undefined,
        },
      ]);
      expect(loadPrefs(home)).toMatchObject({ lastOrg: join(dir, 'org'), lastAdapter: 'mock' });
      // an invalid org shows the load error and blocks submit
      await tab(); // adapter
      await tab(); // workspace
      await tab(); // budget
      await tab(); // org
      for (let i = 0; i < 80; i++) await setup.mockInput.pressBackspace();
      await type(join(dir, 'nope'));
      f = setup.captureCharFrame();
      expect(f).toContain('file not found');
      await setup.mockInput.pressEnter();
      await flush();
      expect(submitted).toHaveLength(1);
    } finally {
      setup.renderer.destroy();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
