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
  let unauthorized = false;
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
      if (unauthorized)
        throw Object.assign(new Error('the bearer token is wrong'), {
          status: 401,
          name: 'AppHttpError',
        });
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
      if (id === 'boom') throw new Error('nothing to steer');
      return runs.get(id)?.state as RunState;
    },
    async auditMarkdown(id: string) {
      rec('auditMarkdown', id);
      return `# Audit of ${id}`;
    },
    async routines() {
      rec('routines');
      return [
        {
          id: 'scan',
          name: 'Weekly scan',
          trigger: { type: 'cron', cron: '0 9 * * 1' },
          orgRoot: '/o',
          project: '/p',
          workflow: 'security-scan',
          input: 'x',
          mode: 'always',
          intervalS: 120,
          enabled: true,
          source: 'org',
          createdAt: 't',
        },
      ] as never;
    },
    async runRoutine(id: string) {
      rec('runRoutine', id);
      return { runId: 'rr' };
    },
    async pauseRoutine(id: string) {
      rec('pauseRoutine', id);
      return {} as never;
    },
    async resumeRoutine(id: string) {
      rec('resumeRoutine', id);
      return {} as never;
    },
    async removeRoutine(id: string) {
      rec('removeRoutine', id);
    },
    async addRoutine(r: unknown) {
      rec('addRoutine', r);
      return {} as never;
    },
    async syncRoutines(orgRoot: string) {
      rec('syncRoutines', orgRoot);
      return {} as never;
    },
    async keys() {
      rec('keys');
      return [{ name: 'OPENAI_API_KEY', description: 'OpenAI', set: false }];
    },
    async setKey(name: string, value: string) {
      rec('setKey', name, value);
      return { name, set: true as const };
    },
    async unsetKey(name: string) {
      rec('unsetKey', name);
      return { name, removed: true };
    },
    async orgConfig(root: string) {
      rec('orgConfig', root);
      return { root, organization: 'wc', tiers: { strong: 'a/b' } };
    },
    async setOrgConfig(root: string, patch: unknown) {
      rec('setOrgConfig', root, patch);
      return { root, organization: 'wc', tiers: {} };
    },
    async mcpList(org: string) {
      rec('mcpList', org);
      return [
        {
          id: 'playwright',
          description: 'browser',
          transport: 'stdio' as const,
          target: 'npx …',
          roles: [],
          keys: [],
        },
      ];
    },
    async mcpTest(id: string, org: string) {
      rec('mcpTest', id, org);
      return { ok: true, tools: [{ name: 'browser_navigate', description: 'go' }] };
    },
    async projectProfile(path: string, org?: string) {
      rec('projectProfile', path, org);
      return { name: 'p', path, git: true, stack: ['node'], files: 3, truncated: false } as never;
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
        descriptions: { 'hello-feature': 'Analyse, implement, test, judge, ship.' },
        catalog: [{ id: 'playwright', type: 'mcp', description: 'browser' }],
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
  return {
    client,
    calls,
    add,
    runs,
    setUnauthorized: (v: boolean) => {
      unauthorized = v;
    },
  };
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

describe('AppStore: the review fixes', () => {
  it('a turn waits for the previous one to settle, and turns of one thread go one at a time', async () => {
    const f = fakeClient();
    f.add('root', { input: { spec: 'Ship it' }, status: 'running' });
    const store = new AppStore({
      client: f.client,
      intervals: { fast: 20, slow: 20 },
      settleEvery: 10,
    });
    store.start();
    store.openThread('root');
    await vi.waitFor(() => expect(store.thread('root')).toBeDefined());
    const sent = store.send('root', 'And then?');
    await new Promise((r) => setTimeout(r, 60));
    expect(f.calls.filter((c) => c.name === 'submitRun')).toHaveLength(0); // still waiting for root to end
    const root = f.runs.get('root') as Turn;
    root.state = { ...root.state, status: 'completed' } as RunState;
    root.summary = { ...root.summary, status: 'completed' };
    await sent;
    expect(f.calls.filter((c) => c.name === 'submitRun')).toHaveLength(1);
    store.stop();
  });
  it('an event turn never marks the thread busy; a user turn does', async () => {
    const f = fakeClient();
    f.add('root', { input: { spec: 'Ship it' } });
    const store = new AppStore({ client: f.client, intervals: { fast: 20, slow: 20 } });
    store.start();
    store.openThread('root');
    await vi.waitFor(() => expect(store.thread('root')).toBeDefined());
    let sawBusy = false;
    const off = store.subscribe(() => {
      if (store.get().busy.root) sawBusy = true;
    });
    await store.send('root', 'workflow x finished', { event: true });
    expect(sawBusy).toBe(false);
    // the event turn ends; the user's turn then goes through and shows busy
    const ev = f.runs.get('new-2') as Turn;
    ev.state = { ...ev.state, status: 'completed' } as RunState;
    ev.summary = { ...ev.summary, status: 'completed' };
    await store.send('root', 'and now?');
    expect(sawBusy).toBe(true);
    off();
    store.stop();
  });
  it('errors of answer, steer, cancel and newChat surface as the state error', async () => {
    const f = fakeClient();
    const store = new AppStore({ client: f.client });
    await store.steer('boom', 'x');
    expect(store.get().error).toContain('nothing to steer');
    store.clearError();
    const noProject = { ...f.client, projects: async () => [] };
    const s2 = new AppStore({ client: noProject });
    await expect(s2.newChat('hi')).resolves.toBeUndefined();
    expect(s2.get().error).toMatch(/no project/);
  });
  it('a 401 from the daemon marks the connection unauthorized instead of "not reachable"', async () => {
    const f = fakeClient();
    f.setUnauthorized(true);
    const store = new AppStore({ client: f.client, intervals: { fast: 20, slow: 20 } });
    store.start();
    await vi.waitFor(() => expect(store.get().unauthorized).toBe(true));
    expect(store.get().reachable).toBe(true);
    store.stop();
  });
  it('the audit comes through the client with the token, as text', async () => {
    const f = fakeClient();
    const store = new AppStore({ client: f.client });
    expect(await store.audit('r1')).toBe('# Audit of r1');
  });
  it('threads are the root runs, with the newest activity of any member', async () => {
    const f = fakeClient();
    f.add('child', {
      thread: 'root',
      parentRunId: 'root',
      workflow: 'hello-feature',
      status: 'running',
    });
    f.add('root', { input: { spec: 'Ship it' }, status: 'completed' });
    const store = new AppStore({ client: f.client, intervals: { fast: 20, slow: 20 } });
    store.start();
    await vi.waitFor(() => expect(store.threads()).toHaveLength(1));
    expect(store.threads()[0]).toMatchObject({
      runId: 'root',
      workflow: 'chat',
      status: 'completed',
    });
    expect(store.threads()[0]?.updatedAt).toBe(f.runs.get('root')?.summary.updatedAt);
    store.stop();
  });
});

describe('AppStore: the sections', () => {
  it('loads routines, skills, memory and integrations on demand and acts on them', async () => {
    const f = fakeClient();
    const store = new AppStore({ client: f.client });
    await store.loadRoutines();
    expect(store.get().routines?.[0]?.id).toBe('scan');
    await store.runRoutine('scan');
    await store.pauseRoutine('scan');
    await store.resumeRoutine('scan');
    await store.removeRoutine('scan');
    await store.addRoutine({
      trigger: { type: 'cron', cron: '* * * * *' },
      workflow: 'w',
      input: 'x',
    });
    await store.syncRoutines();
    expect(f.calls.filter((c) => c.name === 'addRoutine')[0]?.args[0]).toMatchObject({
      orgRoot: '/o',
      project: '/p',
      workflow: 'w',
    });
    await store.loadSkills();
    expect(store.get().skills?.workflows.map((w) => w.name)).toEqual(['chat', 'hello-feature']);
    expect(store.get().skills?.workflows[1]?.description).toMatch(/Analyse/);
    await store.loadMemory();
    expect(store.get().memory?.profile?.stack).toEqual(['node']);
    await store.loadIntegrations();
    expect(store.get().integrations?.mcp[0]?.id).toBe('playwright');
    expect(store.get().integrations?.keys[0]?.name).toBe('OPENAI_API_KEY');
    expect(store.get().integrations?.config?.tiers.strong).toBe('a/b');
    await store.setKey('OPENAI_API_KEY', 'sk');
    await store.unsetKey('OPENAI_API_KEY');
    await store.saveOrgConfig({ judge: null });
    const test = await store.testMcp('playwright');
    expect(test?.tools?.[0]?.name).toBe('browser_navigate');
    expect(f.calls.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        'runRoutine',
        'pauseRoutine',
        'resumeRoutine',
        'removeRoutine',
        'syncRoutines',
        'setKey',
        'unsetKey',
        'setOrgConfig',
        'mcpTest',
        'projectProfile',
      ]),
    );
  });
  it('runWorkflow starts a run of any workflow and opens it; a thread model is used by the next turn', async () => {
    const f = fakeClient();
    f.add('root', { input: { spec: 'hi' } });
    const store = new AppStore({ client: f.client, intervals: { fast: 20, slow: 20 } });
    store.start();
    const id = await store.runWorkflow({
      workflow: 'hello-feature',
      text: 'Add a thing',
      model: 'x/y',
    });
    expect(id).toBe('new-2');
    expect(f.calls.find((c) => c.name === 'submitRun')?.args[0]).toMatchObject({
      workflow: 'hello-feature',
      input: 'Add a thing',
      model: 'x/y',
      workspace: 'worktree',
    });
    expect(store.get().open).toBe('new-2');
    store.openThread('root');
    await vi.waitFor(() => expect(store.thread('root')).toBeDefined());
    store.setThreadModel('root', 'lmstudio/q');
    await store.send('root', 'next');
    expect(f.calls.filter((c) => c.name === 'submitRun')[1]?.args[0]).toMatchObject({
      model: 'lmstudio/q',
      thread: 'root',
    });
    store.stop();
  });
});

describe('AppStore: the slice-2 review fixes', () => {
  it('"the org tiers" after an explicit model really drops the model from the next turn', async () => {
    const f = fakeClient();
    f.add('root', { input: { spec: 'hi' } });
    const store = new AppStore({ client: f.client, intervals: { fast: 20, slow: 20 } });
    store.start();
    store.openThread('root');
    await vi.waitFor(() => expect(store.thread('root')).toBeDefined());
    store.setThreadModel('root', 'lmstudio/q');
    await store.send('root', 'one');
    const t2 = f.runs.get('new-2') as Turn;
    t2.state = { ...t2.state, status: 'completed', model: 'lmstudio/q' } as RunState;
    t2.summary = { ...t2.summary, status: 'completed' };
    store.setThreadModel('root', undefined);
    await store.send('root', 'two');
    const submits = f.calls
      .filter((c) => c.name === 'submitRun')
      .map((c) => c.args[0] as SubmitRequest);
    expect(submits[0]?.model).toBe('lmstudio/q');
    expect(submits[1]?.model).toBeUndefined();
    store.stop();
  });
  it('the routines come with the poll, so the sidebar count is there without visiting Scheduled', async () => {
    const f = fakeClient();
    const store = new AppStore({ client: f.client, intervals: { fast: 20, slow: 20 } });
    store.start();
    await vi.waitFor(() => expect(store.get().routines?.length).toBe(1));
    store.stop();
  });
  it('a failing part of Integrations surfaces as the error, the rest still loads; addRoutine says whether it worked', async () => {
    const f = fakeClient();
    const broken = {
      ...f.client,
      mcpList: async () => {
        throw new Error('org not found');
      },
    };
    const store = new AppStore({ client: broken });
    await store.loadIntegrations();
    expect(store.get().error).toContain('org not found');
    expect(store.get().integrations?.keys[0]?.name).toBe('OPENAI_API_KEY');
    const refusing = {
      ...f.client,
      addRoutine: async () => {
        throw new Error('a command trigger is added from the daemon own machine');
      },
    };
    const s2 = new AppStore({ client: refusing });
    expect(
      await s2.addRoutine({ trigger: { type: 'command', command: 'x' }, workflow: 'w', input: '' }),
    ).toBe(false);
    expect(
      await store.addRoutine({
        trigger: { type: 'cron', cron: '* * * * *' },
        workflow: 'w',
        input: '',
      }),
    ).toBe(true);
  });
});
