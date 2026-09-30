import type { RunState } from '@wizardingcode/shibaox-core';
import type {
  Envelope,
  InboxItem,
  RunSummaryPlus,
  SubmitRequest,
} from '@wizardingcode/shibaox-daemon';
import { describe, expect, it, vi } from 'vitest';
import { AppStore } from '../src/store/store.js';

type Turn = { summary: RunSummaryPlus; state: RunState; frames: Envelope[] };
function fakeClient() {
  const runs = new Map<string, Turn>();
  const calls: { name: string; args: unknown[] }[] = [];
  let seq = 0;
  const rec = (name: string, ...args: unknown[]) => calls.push({ name, args });
  const add = (
    id: string,
    o: Partial<RunSummaryPlus> & {
      input?: Record<string, unknown>;
      status?: RunState['status'];
      frames?: Envelope[];
      nodes?: RunState['nodes'];
    },
  ) => {
    const status = o.status ?? 'completed';
    const summary: RunSummaryPlus = {
      runId: id,
      workflow: o.workflow ?? 'chat',
      status,
      createdAt: `2026-09-30T10:0${++seq}:00.000Z`,
      updatedAt: `2026-09-30T10:0${seq}:30.000Z`,
      spentUsd: 0.01,
      thread: o.thread ?? id,
      parentRunId: o.parentRunId,
      project: '/p',
      orgRoot: '/o',
    } as RunSummaryPlus;
    const state = {
      runId: id,
      workflow: summary.workflow,
      status,
      input: o.input ?? { spec: `request ${id}` },
      workspace: '/p',
      nodes: o.nodes ?? {},
      pendingApprovals: [],
      pendingHumans: [],
      spentUsd: 0.01,
      thread: summary.thread,
      parentRunId: o.parentRunId,
      project: '/p',
      orgRoot: '/o',
      adapter: 'direct',
      workspaceMode: 'inplace',
      model: 'fake/m',
      workflowSnapshot: {
        workflow: 'chat',
        start: 'reply',
        conversation: true,
        nodes: { reply: { type: 'task', role: 'assistant' } },
      },
    } as unknown as RunState;
    runs.set(id, { summary, state, frames: o.frames ?? [] });
    return { summary, state };
  };
  const client = {
    async health() {
      rec('health');
      return {
        version: '0.2.1',
        uptimeSeconds: 1,
        runs: { running: 0, queued: 0, waiting: 0 },
        channels: [],
      };
    },
    async listRuns(q: { thread?: string } = {}) {
      rec('listRuns', q);
      return [...runs.values()]
        .map((t) => t.summary)
        .filter((r) => !q.thread || r.thread === q.thread);
    },
    async getRun(id: string) {
      rec('getRun', id);
      const t = runs.get(id);
      if (!t) throw new Error('not found');
      return t.state;
    },
    async inbox(): Promise<InboxItem[]> {
      rec('inbox');
      return [];
    },
    async submitRun(req: SubmitRequest) {
      rec('submitRun', req);
      const id = `new-${runs.size + 1}`;
      add(id, {
        thread: req.thread ?? id,
        input: { spec: req.input, ...(req.event ? { event: true } : {}) },
        status: 'running',
      });
      return { runId: id, warnings: [] };
    },
    async answer(id: string, a: unknown) {
      rec('answer', id, a);
      return {};
    },
    async steer(id: string, o: unknown) {
      rec('steer', id, o);
      return runs.get(id)?.state as RunState;
    },
    async cancel(id: string) {
      rec('cancel', id);
      return {};
    },
    async resume(id: string) {
      rec('resume', id);
      return {};
    },
    async models() {
      return [];
    },
    async projects() {
      return [{ path: '/p', source: 'config' as const }];
    },
    async defaultOrg() {
      return { root: '/o', created: false };
    },
    async orgInfo(root: string) {
      rec('orgInfo', root);
      return {
        workflows: ['chat', 'hello-feature'],
        single: ['chat'],
        subscription: false,
        adapter: 'direct' as const,
      };
    },
    async *stream(id: string) {
      rec('stream', id);
      const t = runs.get(id);
      for (const f of t?.frames ?? []) yield f;
      if (t && t.state.status !== 'running')
        yield { kind: 'end', seq: 99, cursor: '99:0', status: t.state.status } as Envelope;
    },
  };
  return { client, calls, add, runs };
}

const frame = (seq: number, type: string, extra: Record<string, unknown>): Envelope =>
  ({
    kind: 'run',
    seq,
    cursor: `${seq}:0`,
    event: { seq, type, at: 't', runId: 'x', ...extra },
  }) as Envelope;
const text = (seq: number, nodeId: string, t: string): Envelope =>
  ({
    kind: 'runtime',
    seq,
    cursor: `1:${seq}`,
    event: { runId: 'x', nodeId, seq, at: 't', event: { type: 'text', text: t } },
  }) as Envelope;

describe('AppStore', () => {
  it('opening a thread streams its turns and shows the conversation', async () => {
    const f = fakeClient();
    f.add('root', {
      input: { spec: 'Find a hotel' },
      frames: [
        frame(1, 'NodeStarted', { nodeId: 'reply' }),
        text(1, 'reply', 'On it.'),
        frame(2, 'NodeCompleted', { nodeId: 'reply', output: {}, summary: '' }),
      ],
    });
    f.add('turn2', {
      thread: 'root',
      input: {
        spec: 'Book it',
        messages: [
          { role: 'user', content: 'Find a hotel' },
          { role: 'assistant', content: 'On it.' },
        ],
      },
      status: 'running',
    });
    const store = new AppStore({ client: f.client, intervals: { fast: 20, slow: 20 } });
    store.start();
    store.openThread('root');
    await vi.waitFor(() => expect(store.thread('root')?.messages.length).toBe(4));
    const v = store.thread('root');
    expect(v?.title).toBe('Find a hotel');
    expect(v?.messages.map((m) => [m.from, m.text])).toEqual([
      ['user', 'Find a hotel'],
      ['agent', 'On it.'],
      ['user', 'Book it'],
      ['agent', ''],
    ]);
    expect(v?.messages[3]?.pending).toBe(true);
    expect(v?.status).toBe('working');
    store.stop();
  });
  it('send submits the next turn with the conversation so far and the thread; stop cancels the live turn', async () => {
    const f = fakeClient();
    f.add('root', {
      input: { spec: 'Find a hotel' },
      frames: [
        frame(1, 'NodeStarted', { nodeId: 'reply' }),
        text(1, 'reply', 'On it.'),
        frame(2, 'NodeCompleted', { nodeId: 'reply', output: {}, summary: '' }),
      ],
    });
    const store = new AppStore({ client: f.client, intervals: { fast: 20, slow: 20 } });
    store.start();
    store.openThread('root');
    await vi.waitFor(() => expect(store.thread('root')?.messages.length).toBe(2));
    await store.send('root', 'Book it');
    const submit = f.calls.find((c) => c.name === 'submitRun')?.args[0] as SubmitRequest;
    expect(submit).toMatchObject({
      orgRoot: '/o',
      project: '/p',
      workflow: 'chat',
      input: 'Book it',
      thread: 'root',
      adapter: 'direct',
      workspace: 'inplace',
      model: 'fake/m',
      messages: [
        { role: 'user', content: 'Find a hotel' },
        { role: 'assistant', content: 'On it.' },
      ],
    });
    await vi.waitFor(() =>
      expect(store.turnsOf('root').map((t) => t.runId)).toEqual(['root', 'new-2']),
    );
    await store.stopThread('root');
    expect(f.calls.find((c) => c.name === 'cancel')?.args).toEqual(['new-2']);
    store.stop();
  });
  it('newChat starts a chat run on the default project and org, and opens it', async () => {
    const f = fakeClient();
    const store = new AppStore({ client: f.client, intervals: { fast: 20, slow: 20 } });
    store.start();
    const id = await store.newChat('Hello there');
    expect(id).toBe('new-1');
    expect(f.calls.find((c) => c.name === 'submitRun')?.args[0]).toMatchObject({
      orgRoot: '/o',
      project: '/p',
      workflow: 'chat',
      input: 'Hello there',
      adapter: 'direct',
      workspace: 'inplace',
    });
    expect(store.get().open).toBe('new-1');
    store.stop();
  });
  it('a dispatched run of the open thread that ends is reported to the orchestrator once, as an event turn', async () => {
    const f = fakeClient();
    f.add('root', { input: { spec: 'Ship it' } });
    f.add('child', {
      thread: 'root',
      parentRunId: 'root',
      workflow: 'hello-feature',
      status: 'running',
      input: { spec: 'build' },
    });
    const store = new AppStore({ client: f.client, intervals: { fast: 20, slow: 20 } });
    store.start();
    store.openThread('root');
    await vi.waitFor(() => expect(store.tasksOf('root').map((t) => t.runId)).toEqual(['child']));
    // the child finishes
    const child = f.runs.get('child') as Turn;
    child.state = { ...child.state, status: 'completed' } as RunState;
    child.summary = { ...child.summary, status: 'completed' };
    await vi.waitFor(() => expect(f.calls.filter((c) => c.name === 'submitRun')).toHaveLength(1));
    const req = f.calls.find((c) => c.name === 'submitRun')?.args[0] as SubmitRequest;
    expect(req.event).toBe(true);
    expect(req.input).toContain('workflow hello-feature finished: completed');
    await new Promise((r) => setTimeout(r, 80));
    expect(f.calls.filter((c) => c.name === 'submitRun')).toHaveLength(1);
    store.stop();
  });
  it('answers, steers, resumes and keeps settings', async () => {
    const f = fakeClient();
    const storage = new Map<string, string>();
    const store = new AppStore({
      client: f.client,
      storage: {
        getItem: (k) => storage.get(k) ?? null,
        setItem: (k, v) => void storage.set(k, v),
        removeItem: (k) => void storage.delete(k),
      },
    });
    await store.answer('approval:1', true, 'go');
    await store.steer('r1', 'left');
    await store.resume('r1');
    expect(f.calls.map((c) => c.name)).toEqual(
      expect.arrayContaining(['answer', 'steer', 'resume']),
    );
    store.setSettings({ theme: 'dark', name: 'André' });
    expect(JSON.parse(storage.get('shibaox.settings') ?? '{}')).toMatchObject({
      theme: 'dark',
      name: 'André',
    });
    expect(store.get().settings.theme).toBe('dark');
  });
});
