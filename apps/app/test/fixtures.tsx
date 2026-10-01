import { render } from '@testing-library/react';
import type { RunState } from '@wizardingcode/shibaox-core';
import type { Envelope, InboxItem, RunSummaryPlus } from '@wizardingcode/shibaox-daemon';
import { App } from '../src/App.js';
import { AppStore, type StoreClient } from '../src/store/store.js';

export const summary = (id: string, o: Partial<RunSummaryPlus> = {}): RunSummaryPlus =>
  ({
    runId: id,
    workflow: 'chat',
    status: 'completed',
    createdAt: '2026-09-30T10:00:00.000Z',
    updatedAt: '2026-09-30T10:00:30.000Z',
    spentUsd: 0.012,
    thread: id,
    project: '/p',
    orgRoot: '/o',
    ...o,
  }) as RunSummaryPlus;
export const state = (
  id: string,
  o: Partial<RunState> & { input?: Record<string, unknown> } = {},
): RunState =>
  ({
    runId: id,
    workflow: 'chat',
    status: 'completed',
    input: { spec: 'Find me a hotel in Porto' },
    workspace: '/p',
    nodes: {},
    pendingApprovals: [],
    pendingHumans: [],
    spentUsd: 0.012,
    thread: id,
    project: '/p',
    orgRoot: '/o',
    adapter: 'direct',
    workspaceMode: 'inplace',
    model: 'anthropic/claude-opus',
    workflowSnapshot: {
      workflow: 'chat',
      start: 'reply',
      conversation: true,
      nodes: { reply: { type: 'task', role: 'assistant' } },
    },
    ...o,
  }) as unknown as RunState;
export const runFrame = (seq: number, type: string, extra: Record<string, unknown>): Envelope =>
  ({
    kind: 'run',
    seq,
    cursor: `${seq}:0`,
    event: { seq, type, at: 't', runId: 'x', ...extra },
  }) as Envelope;
export const rtFrame = (seq: number, nodeId: string, event: Record<string, unknown>): Envelope =>
  ({
    kind: 'runtime',
    seq,
    cursor: `1:${seq}`,
    event: { runId: 'x', nodeId, seq, at: 't', event },
  }) as Envelope;

export function client(
  o: {
    runs?: RunSummaryPlus[];
    states?: Record<string, RunState>;
    frames?: Record<string, Envelope[]>;
    inbox?: InboxItem[];
    routines?: unknown[];
  } = {},
) {
  const calls: { name: string; args: unknown[] }[] = [];
  const rec = (name: string, ...args: unknown[]) => calls.push({ name, args });
  const c: StoreClient = {
    async health() {
      return {
        version: '0.2.1',
        uptimeSeconds: 1,
        runs: { running: 0, queued: 0, waiting: 0 },
        channels: [],
      };
    },
    async listRuns() {
      return o.runs ?? [];
    },
    async getRun(id) {
      const s = o.states?.[id];
      if (!s) throw new Error('not found');
      return s;
    },
    async inbox() {
      return o.inbox ?? [];
    },
    async submitRun(req) {
      rec('submitRun', req);
      return { runId: 'new-1', warnings: [] };
    },
    async answer(id, a) {
      rec('answer', id, a);
      return {};
    },
    async steer(id, s) {
      rec('steer', id, s);
      return o.states?.[id] as RunState;
    },
    async files(id) {
      rec('files', id);
      return { root: '/p', files: [] };
    },
    async writeFile(id, path, content) {
      rec('writeFile', id, path, content);
      return { path, size: content.length };
    },
    async fileContent(id, path) {
      rec('fileContent', id, path);
      return { path, size: 5, encoding: 'utf8' as const, content: 'name\n', truncated: false };
    },
    async fileBlob(id, path) {
      rec('fileBlob', id, path);
      return new Blob(['name\n']);
    },
    async auditMarkdown(id) {
      rec('auditMarkdown', id);
      return `# Audit ${id}`;
    },
    async cancel(id) {
      rec('cancel', id);
      return {};
    },
    async resume(id) {
      rec('resume', id);
      return {};
    },
    async decisions() {
      return {
        decider: {
          kind: 'model' as const,
          ref: 'openrouter/typesafe/jev-router',
          usable: false,
          reason: 'missing OPENROUTER_API_KEY',
        },
        decisions: [
          {
            runId: 'root',
            nodeId: 'judge',
            choice: 'ship',
            confidence: 0.91,
            by: 'model:openrouter/typesafe/jev-router',
            at: '2026-10-01T10:00:00.000Z',
          },
        ],
      };
    },
    async models() {
      return [
        {
          ref: 'anthropic/claude-opus',
          provider: 'anthropic',
          model: 'claude-opus',
          configured: true,
        },
        {
          ref: 'lmstudio/qwen',
          provider: 'lmstudio',
          model: 'qwen',
          configured: true,
          local: true,
          available: true,
        },
        {
          ref: 'openai/gpt-5',
          provider: 'openai',
          model: 'gpt-5',
          configured: false,
          missing: ['OPENAI_API_KEY'],
        },
      ];
    },
    async projects() {
      return [{ path: '/p', source: 'config' as const }];
    },
    async defaultOrg() {
      return { root: '/o', created: false };
    },
    async orgInfo() {
      return {
        workflows: ['chat'],
        single: ['chat'],
        subscription: false,
        adapter: 'direct' as const,
        descriptions: {},
        catalog: [],
      };
    },
    async *stream(id) {
      for (const f of o.frames?.[id] ?? []) yield f;
      const st = o.states?.[id];
      if (st && st.status !== 'running')
        yield { kind: 'end', seq: 99, cursor: '99:0', status: st.status } as Envelope;
    },
    async routines() {
      return (o.routines ?? []) as never;
    },
    async runRoutine(id) {
      rec('runRoutine', id);
      return { runId: 'rr' };
    },
    async pauseRoutine(id) {
      rec('pauseRoutine', id);
      return {} as never;
    },
    async resumeRoutine(id) {
      rec('resumeRoutine', id);
      return {} as never;
    },
    async removeRoutine(id) {
      rec('removeRoutine', id);
    },
    async addRoutine(r) {
      rec('addRoutine', r);
      return {} as never;
    },
    async updateRoutine(id, patch) {
      rec('updateRoutine', id, patch);
      return {} as never;
    },
    async draftRoutine(r) {
      rec('draftRoutine', r);
      return {
        name: 'Daily briefing',
        description: 'What changed yesterday',
        trigger: { type: 'cron' as const, cron: '0 9 * * 1-5' },
        workflow: 'chat',
        input: "Summarise yesterday's commits, PRs and issues.",
        approvals: 'inbox' as const,
        words: 'Weekdays at 09:00',
      };
    },
    async syncRoutines(org) {
      rec('syncRoutines', org);
      return {};
    },
    async keys() {
      return [
        { name: 'OPENAI_API_KEY', description: 'OpenAI', set: false },
        {
          name: 'GH_TOKEN',
          description: 'GitHub',
          set: true,
          source: 'vault' as const,
          masked: 'gh…12',
        },
      ];
    },
    async setKey(name, value) {
      rec('setKey', name, value);
      return { name, set: true as const };
    },
    async unsetKey(name) {
      rec('unsetKey', name);
      return { name, removed: true };
    },
    async orgConfig(root) {
      return {
        root,
        organization: 'wc',
        tiers: { strong: 'anthropic/claude-opus', cheap: 'openai/gpt-5-mini' },
        adapter: 'direct' as const,
        per_run_usd: 3,
      };
    },
    async setOrgConfig(root, patch) {
      rec('setOrgConfig', root, patch);
      return { root, organization: 'wc', tiers: {} };
    },
    async mcpList() {
      return [
        {
          id: 'playwright',
          description: 'A browser',
          transport: 'stdio' as const,
          target: 'npx -y @playwright/mcp',
          roles: ['browser-qa'],
          keys: [{ name: 'PW_TOKEN', present: false }],
        },
      ];
    },
    async mcpTest(id, org) {
      rec('mcpTest', id, org);
      return { ok: true, tools: [{ name: 'browser_navigate', description: 'Open a page' }] };
    },
    async projectProfile(path) {
      return {
        name: 'sample',
        path,
        git: true,
        branch: 'main',
        stack: ['node'],
        packageManager: 'pnpm',
        testCommand: 'pnpm test',
        files: 12,
        truncated: false,
      } as never;
    },
  };
  return { client: c, calls };
}

export const storage = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
};

export const mount = (
  c: StoreClient,
  o: { hash?: string; connected?: boolean; store?: AppStore } = {},
) => {
  window.location.hash = o.hash ?? '';
  const st =
    o.store ?? new AppStore({ client: c, storage: storage(), intervals: { fast: 20, slow: 20 } });
  const s = storage();
  if (o.connected !== false)
    s.setItem('shibaox.connection', JSON.stringify({ base: 'http://d', token: 't' }));
  const ui = render(<App store={st} storage={s} connect={() => c} />);
  return { ...ui, store: st };
};
