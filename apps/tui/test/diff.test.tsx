import { expect, test } from 'bun:test';
import { testRender } from '@opentui/solid';
import type { RunState } from '@wizardingcode/shibaox-core';
import { App } from '../src/app.js';
import { FakeDaemonClient } from '../src/testing/fake-client.js';

const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const state = (): RunState =>
  ({
    runId: 'r1',
    workflow: 'hello-feature',
    input: {},
    workspace: '/w',
    status: 'completed',
    nodes: {},
    spentUsd: 0.1,
    budgetWarned: false,
    pendingHumans: [],
    pendingApprovals: [],
  }) as RunState;
const patch = `diff --git a/a.ts b/a.ts
index 1111111..2222222 100644
--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-export const a = 1;
+export const a = 2;
diff --git a/b.ts b/b.ts
new file mode 100644
--- /dev/null
+++ b/b.ts
@@ -0,0 +1,2 @@
+export const b = 1;
+export const c = 2;
`;

async function mount(o: { diff?: boolean } = {}) {
  const client = new FakeDaemonClient();
  client.runs = [
    {
      runId: 'r1',
      workflow: 'hello-feature',
      status: 'completed',
      createdAt: 'x',
      updatedAt: 'x',
      spentUsd: 0.1,
    } as never,
  ];
  client.states.set('r1', state());
  if (o.diff !== false)
    client.diffs.set('r1', {
      base: 'HEAD',
      truncated: false,
      files: [
        { path: 'a.ts', status: 'modified', additions: 1, deletions: 1 },
        { path: 'b.ts', status: 'added', additions: 2, deletions: 0 },
      ],
      patch,
    });
  const setup = await testRender(
    () => (
      <App
        client={client}
        runId="r1"
        version="0.0.1"
        home="/tmp/shx-home"
        cwd="/tmp"
        env={{ SHIBAOX_NO_MOTION: '1' }}
        onExit={() => {}}
      />
    ),
    { width: 140, height: 30, exitOnCtrlC: false },
  );
  const frame = async () => {
    await settle();
    await setup.renderOnce();
    await settle();
    await setup.renderOnce();
    return setup.captureCharFrame();
  };
  const key = async (k: string) => {
    if (k === 'escape') await setup.mockInput.pressEscape();
    else await setup.mockInput.pressKey(k);
    return frame();
  };
  return { client, setup, frame, key, done: () => setup.renderer.destroy() };
}

test('d opens the diff viewer: file list, patch of the selected file, ] moves on, esc closes', async () => {
  const m = await mount();
  try {
    await m.frame();
    let f = await m.key('d');
    expect(f).toContain('2 files · +3 −1');
    expect(f).toContain('a.ts');
    expect(f).toContain('b.ts');
    expect(f).toContain('export const a = 2;');
    expect(f).not.toContain('export const c = 2;');
    f = await m.key(']');
    expect(f).toContain('export const c = 2;');
    f = await m.key('escape');
    expect(f).not.toContain('2 files');
  } finally {
    m.done();
  }
});

test('a gone workspace says so', async () => {
  const m = await mount({ diff: false });
  try {
    await m.frame();
    const f = await m.key('d');
    expect(f).toContain('Workspace is gone');
  } finally {
    m.done();
  }
});
