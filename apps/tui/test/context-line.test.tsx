import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testRender } from '@opentui/solid';
import type { RunState } from '@wizardingcode/shibaox-core';
import { type Envelope, scaffoldOrg } from '@wizardingcode/shibaox-daemon';
import { App, type AppHooks } from '../src/app.js';
import { FakeDaemonClient } from '../src/testing/fake-client.js';

const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const chatState = (orgRoot: string, project: string, status = 'completed'): RunState =>
  ({
    runId: 'r1',
    workflow: 'chat',
    workflowSnapshot: {
      workflow: 'chat',
      conversation: true,
      start: 'reply',
      nodes: { reply: { type: 'task', role: 'assistant' } },
    },
    input: { spec: 'olá' },
    workspace: project,
    project,
    orgRoot,
    adapter: 'claude-code',
    status,
    nodes: {
      reply: {
        status: status === 'completed' ? 'completed' : 'running',
        attempts: 1,
        approvals: {},
      },
    },
    spentUsd: 0.05,
    budgetWarned: false,
    pendingHumans: [],
    pendingApprovals: [],
  }) as unknown as RunState;
let seq = 0;
const runtime = (event: Record<string, unknown>): Envelope =>
  ({
    kind: 'runtime',
    seq: ++seq,
    cursor: `0:${seq}`,
    event: { runId: 'r1', nodeId: 'reply', seq, at: 'x', event },
  }) as unknown as Envelope;

async function mount(o: { status?: string; usage: boolean; branch?: string }) {
  const dir = mkdtempSync(join(tmpdir(), 'tui-ctx-'));
  scaffoldOrg(dir);
  const orgRoot = join(dir, 'org');
  const project = join(dir, 'proj');
  const client = new FakeDaemonClient();
  client.runs = [
    {
      runId: 'r1',
      workflow: 'chat',
      status: o.status ?? 'completed',
      createdAt: 'x',
      updatedAt: 'x',
      spentUsd: 0.05,
    } as never,
  ];
  client.states.set('r1', chatState(orgRoot, project, o.status));
  client.profiles.set(project, {
    name: 'proj',
    path: project,
    git: !!o.branch,
    ...(o.branch ? { branch: o.branch } : {}),
    stack: ['JavaScript'],
    files: 3,
    truncated: false,
    languages: [],
    summary: 'JavaScript · 3 files',
  });
  const frames: Envelope[] = [
    {
      kind: 'run',
      seq: 1,
      cursor: '1:0',
      event: { runId: 'r1', at: 'x', seq: 1, type: 'NodeStarted', nodeId: 'reply' },
    } as unknown as Envelope,
    ...(o.usage
      ? [
          runtime({ type: 'usage', model: 'claude-haiku-4-5' }),
          runtime({ type: 'text', text: 'Olá!' }),
          runtime({
            type: 'usage',
            model: 'claude-haiku-4-5',
            contextTokens: 24_000,
            contextWindow: 200_000,
            inputTokens: 100,
            outputTokens: 20,
          }),
        ]
      : [runtime({ type: 'text', text: 'Olá!' })]),
    ...((o.status ?? 'completed') === 'completed'
      ? [{ kind: 'end', seq: 99, cursor: '99:0', status: 'completed' } as unknown as Envelope]
      : []),
  ];
  client.history.set('r1', frames);
  let hooks: AppHooks | undefined;
  const setup = await testRender(
    () => (
      <App
        client={client}
        version="0.0.1"
        home={join(dir, 'home')}
        cwd={dir}
        env={{ SHIBAOX_NO_MOTION: '1', HOME: dir }}
        onExit={() => {}}
        onMount={(h) => {
          hooks = h;
          h.data.openRun('r1');
        }}
      />
    ),
    { width: 120, height: 34, exitOnCtrlC: false },
  );
  const frame = async () => {
    await settle();
    await setup.renderOnce();
    await settle();
    await setup.renderOnce();
    return setup.captureCharFrame();
  };
  const done = () => {
    setup.renderer.destroy();
    rmSync(dir, { recursive: true, force: true });
  };
  return { frame, done, hooks: () => hooks };
}

test('under the prompt: context used, model, branch, project, org and workflow', async () => {
  const m = await mount({ usage: true, branch: 'main' });
  try {
    let f = await m.frame();
    for (let i = 0; i < 40 && !f.includes('12% ctx'); i++) f = await m.frame();
    expect(f).toContain('12% ctx');
    expect(f).toContain('claude-haiku-4-5');
    expect(f).toContain('⎇ main');
    expect(f).toContain('~/proj');
    expect(f).toContain('my-org');
    expect(f).toContain('chat');
    expect(f).toContain('$0.05');
    expect(f).toContain('Continue');
  } finally {
    m.done();
  }
});

test('while working and without usage frames, the planned model of the role shows and no branch without git', async () => {
  const m = await mount({ status: 'running', usage: false });
  try {
    let f = await m.frame();
    for (let i = 0; i < 40 && !f.includes('Working'); i++) f = await m.frame();
    expect(f).toContain('Working');
    expect(f).toContain('ollama/llama3.2'); // the assistant's tier (cheap) in the template org
    expect(f).not.toContain('⎇');
    expect(f).not.toContain('% ctx');
    expect(f).toContain('~/proj');
  } finally {
    m.done();
  }
});
