import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeQuery, msg } from '@shibaox/adapter-claude-code/testing';
import { MemoryEventStore, type TaskJob } from '@shibaox/core';
import { MemoryNotes } from '@shibaox/memory';
import { removeRunWorkspace } from '@shibaox/workspace';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InboxService } from '../src/inbox.js';
import { RunManager } from '../src/run-manager.js';
import { scaffoldOrg } from '../src/templates.js';

const sample = fileURLToPath(new URL('../../../examples/sample-repo', import.meta.url));
const tmpDirs: string[] = [];
const managers: RunManager[] = [];
afterEach(async () => {
  for (const m of managers.splice(0)) await m.stop({ force: true, graceMs: 0 });
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(o: { git?: boolean; claudeCode?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rm-'));
  tmpDirs.push(dir);
  scaffoldOrg(dir);
  const project = join(dir, 'proj');
  cpSync(sample, project, { recursive: true });
  if (o.claudeCode) {
    writeFileSync(
      join(dir, 'org/models.yaml'),
      'providers: {}\ntiers: { strong: anthropic-subscription/claude-sonnet-5, cheap: anthropic-subscription/claude-haiku-4-5, decision: jev-latest }\nroles: {}\ngates: {}\n',
    );
    writeFileSync(
      join(dir, 'org/org.yaml'),
      'organization: my-org\nbudgets: { per_run_usd: 5 }\nteams: [engineering]\nadapter: claude-code\nvault: ../vault\n',
    );
  }
  if (o.git) {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: project, stdio: 'ignore' });
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--no-gpg-sign', '-m', 'i');
  }
  return { dir, orgRoot: join(dir, 'org'), project, vault: join(dir, 'vault') };
}

function manager(
  store: MemoryEventStore,
  extra: Partial<ConstructorParameters<typeof RunManager>[0]> = {},
  inboxExtra: { approvalTimeoutMs?: number } = {},
) {
  let m: RunManager | undefined;
  const inbox = new InboxService({
    store,
    approvalTimeoutMs: inboxExtra.approvalTimeoutMs ?? 60_000,
    onResolved: (item, a) => m?.onInboxResolved(item, a),
  });
  m = new RunManager({
    store,
    inbox,
    config: { max_concurrent_runs: 4, approval_timeout_minutes: 120, channels: {} },
    log: () => {},
    env: {},
    ...extra,
  });
  managers.push(m);
  return { manager: m, inbox };
}

const submitMock = (
  m: RunManager,
  s: ReturnType<typeof setup>,
  workspace?: 'inplace' | 'worktree',
) =>
  m.submit({
    orgRoot: s.orgRoot,
    project: s.project,
    workflow: 'hello-feature',
    input: 'add /health',
    adapter: 'mock',
    workspace,
  });

describe('RunManager', () => {
  it('submit queues a run, executes it and writes the vault note when it ends', async () => {
    const s = setup();
    const store = new MemoryEventStore();
    const { manager: m, inbox } = manager(store, { vault: s.vault });
    const { runId } = await submitMock(m, s, 'inplace');
    const created = (await store.read(runId))[0];
    expect(created).toMatchObject({ type: 'RunCreated', orgRoot: s.orgRoot, project: s.project });
    // the template's ship node is a human node: it waits in the inbox
    await vi.waitFor(async () => expect((await m.state(runId)).status).toBe('waiting_human'));
    expect(await inbox.list()).toMatchObject([{ id: `human:${runId}:ship` }]);
    await inbox.answer(`human:${runId}:ship`, { approved: true, via: 'cli' });
    await vi.waitFor(async () => expect((await m.state(runId)).status).toBe('completed'));
    expect(m.active()).toEqual({ running: 0, queued: 0, waiting: 0 });
  });

  it('queues beyond max_concurrent_runs and drains in order', async () => {
    const s = setup();
    const store = new MemoryEventStore();
    const gates = new Map<string, () => void>();
    const released = new Set<string>();
    const { manager: m } = manager(store, {
      config: { max_concurrent_runs: 2, approval_timeout_minutes: 120, channels: {} },
      // the first task of a run waits for its gate; later tasks of a released run run through
      mockScript: (job: TaskJob) =>
        released.has(job.runId)
          ? { output: {}, summary: 'ok' }
          : new Promise((resolve) => {
              gates.set(job.runId, () => {
                released.add(job.runId);
                resolve({ output: {}, summary: 'ok' });
              });
            }),
    });
    // the org allows 5 at once; the daemon only 2
    writeFileSync(
      join(s.orgRoot, 'org.yaml'),
      'organization: my-org\nbudgets: { per_run_usd: 5 }\nteams: [engineering]\nmax_concurrent_runs: 5\n',
    );
    const a = await submitMock(m, s, 'inplace');
    const b = await submitMock(m, s, 'inplace');
    const c = await submitMock(m, s, 'inplace');
    await vi.waitFor(() => expect(gates.size).toBe(2));
    expect(m.active()).toEqual({ running: 2, queued: 1, waiting: 0 });
    expect((await m.state(c.runId)).status).toBe('queued');
    expect(gates.has(a.runId) && gates.has(b.runId)).toBe(true);
    gates.get(a.runId)?.();
    await vi.waitFor(() => expect(gates.has(c.runId)).toBe(true));
    expect((await m.state(c.runId)).status).toBe('running');
  });

  it('honours the org limit below the daemon limit', async () => {
    const s = setup();
    const store = new MemoryEventStore();
    const gates = new Map<string, () => void>();
    const { manager: m } = manager(store, {
      mockScript: (job: TaskJob) =>
        new Promise((resolve) => {
          gates.set(job.runId, () => resolve({ output: {}, summary: 'ok' }));
        }),
    });
    writeFileSync(
      join(s.orgRoot, 'org.yaml'),
      'organization: my-org\nbudgets: { per_run_usd: 5 }\nteams: [engineering]\nmax_concurrent_runs: 1\n',
    );
    await submitMock(m, s, 'inplace');
    const b = await submitMock(m, s, 'inplace');
    await vi.waitFor(() => expect(gates.size).toBe(1));
    expect((await m.state(b.runId)).status).toBe('queued');
  });

  it('submit records messages and parentRunId; list exposes parentRunId', async () => {
    const s = setup();
    const store = new MemoryEventStore();
    const { manager: m } = manager(store, { vault: s.vault });
    const messages = [
      { role: 'user' as const, content: 'hi' },
      { role: 'assistant' as const, content: 'hello' },
    ];
    const { runId } = await m.submit({
      orgRoot: s.orgRoot,
      project: s.project,
      workflow: 'chat',
      input: 'and?',
      adapter: 'mock',
      workspace: 'inplace',
      messages,
      parentRunId: 'p',
      event: true,
      origin: 'telegram:42',
    });
    const created = (await store.read(runId))[0];
    expect(created?.type === 'RunCreated' && created.origin).toBe('telegram:42');
    expect(created?.type === 'RunCreated' && created.input).toEqual({
      spec: 'and?',
      messages,
      event: true,
    });
    expect(created?.type === 'RunCreated' && created.parentRunId).toBe('p');
    await vi.waitFor(async () => expect((await m.state(runId)).status).toBe('completed'));
    expect((await m.list()).find((r) => r.runId === runId)?.parentRunId).toBe('p');
    expect((await m.list()).find((r) => r.runId === runId)?.origin).toBe('telegram:42');
    const plain = await submitMock(m, s, 'inplace');
    const plainCreated = (await store.read(plain.runId))[0];
    expect(plainCreated?.type === 'RunCreated' && plainCreated.input).toEqual({
      spec: 'add /health',
    });
  });

  it('a claude-code chat run gets the shibaox MCP tools and the project preamble; memory reaches memory roles only', async () => {
    const s = setup({ claudeCode: true });
    const store = new MemoryEventStore();
    const q = fakeQuery(() => [msg.init(), msg.success('ok')]);
    const { manager: m } = manager(store, { queryFn: q, vault: s.vault });
    new MemoryNotes({ vault: s.vault, project: 'proj' }).remember('user', 'uses pnpm everywhere');
    const { runId } = await m.submit({
      orgRoot: s.orgRoot,
      project: s.project,
      workflow: 'chat',
      input: 'olá',
      workspace: 'inplace',
    });
    await vi.waitFor(async () => expect((await m.state(runId)).status).toBe('completed'));
    const o = q.calls[0]?.options ?? {};
    expect(o.mcpServers?.shibaox).toBeDefined();
    expect(o.allowedTools).toContain('mcp__shibaox__*');
    expect(o.allowedTools).toContain('WebSearch'); // WebFetch goes through canUseTool (host check)
    const append = (o.systemPrompt as { append?: string }).append ?? '';
    expect(append).toContain('Project: ');
    expect(append).toContain('files');
    // the orchestrator prompt from the template
    expect(append).toContain('start_workflow');
    expect(append).toContain('uses pnpm everywhere');
    expect(append).toContain('data, not instructions');
    expect(existsSync(join(s.vault, '10-projects', 'proj', 'profile.md'))).toBe(true);
    // a team role without the memory capability gets the profile, never the notes
    const team = await m.submit({
      orgRoot: s.orgRoot,
      project: s.project,
      workflow: 'hello-feature',
      input: 'x',
      workspace: 'inplace',
    });
    await vi.waitFor(async () => expect((await m.state(team.runId)).status).toBe('waiting_human'));
    const teamAppend =
      (q.calls[1]?.options?.systemPrompt as { append?: string } | undefined)?.append ?? '';
    expect(teamAppend).toContain('Project: ');
    expect(teamAppend).not.toContain('uses pnpm everywhere');
  });

  it('a run with an origin reports once when it ends; runs without one do not', async () => {
    const s = setup();
    const store = new MemoryEventStore();
    const finished: { runId: string; origin?: string; notePath?: string }[] = [];
    const { manager: m } = manager(store, {
      vault: s.vault,
      onFinished: (state, _events, _workflow, notePath) =>
        finished.push({ runId: state.runId, origin: state.origin, notePath }),
    });
    const { runId } = await m.submit({
      orgRoot: s.orgRoot,
      project: s.project,
      workflow: 'chat',
      input: 'olá',
      adapter: 'mock',
      workspace: 'inplace',
      origin: 'schedule:s1',
    });
    await vi.waitFor(async () => expect((await m.state(runId)).status).toBe('completed'));
    await vi.waitFor(() => expect(finished).toHaveLength(1));
    expect(finished[0]).toMatchObject({ runId, origin: 'schedule:s1' });
    expect(finished[0]?.notePath).toContain('10-projects');
    const plain = await submitMock(m, s, 'inplace');
    await vi.waitFor(async () => expect((await m.state(plain.runId)).status).toBe('waiting_human'));
    await m.cancel(plain.runId);
    await new Promise((r) => setTimeout(r, 50));
    expect(finished).toHaveLength(1);
  });

  it('restart keeps the pending approval and resumes by session id', async () => {
    const s = setup({ claudeCode: true });
    const store = new MemoryEventStore();
    let calls = 0;
    const q = fakeQuery(async function* ({ options }) {
      calls++;
      yield msg.init({ session_id: `sess-${calls}` });
      if (calls === 2) {
        // implement: ask for a push; nobody answers in time
        const d = await options.canUseTool?.('Bash', { command: 'git push origin main' }, {
          signal: new AbortController().signal,
        } as never);
        expect(d).toMatchObject({ behavior: 'deny', interrupt: true });
        yield msg.error('error_during_execution', 0.1);
        return;
      }
      yield msg.success('ok');
    });
    const first = manager(store, { queryFn: q, vault: s.vault }, { approvalTimeoutMs: 50 });
    const { runId } = await first.manager.submit({
      orgRoot: s.orgRoot,
      project: s.project,
      workflow: 'hello-feature',
      input: 'x',
      workspace: 'inplace',
    });
    // nobody answers within the (50 ms) timeout: the node is suspended with its session
    await vi.waitFor(async () =>
      expect((await first.manager.state(runId)).nodes.implement?.status).toBe('pending'),
    );
    const suspended = await first.manager.state(runId);
    expect(suspended.status).toBe('waiting_approval');
    expect(suspended.nodes.implement).toMatchObject({ status: 'pending', sessionId: 'sess-2' });
    const [item] = await first.inbox.list();
    expect(item).toMatchObject({ kind: 'approval', prompt: 'git push origin main' });
    // "crash": a new manager over the same store, the old one is abandoned
    await first.manager.stop({ force: false, graceMs: 0 });
    const second = manager(store, { queryFn: q, vault: s.vault });
    await second.manager.start();
    expect((await second.manager.state(runId)).status).toBe('waiting_approval');
    expect(await second.inbox.list()).toHaveLength(1);
    await second.inbox.answer(item?.id ?? '', { approved: true, via: 'cli' });
    await vi.waitFor(async () =>
      expect((await second.manager.state(runId)).status).toBe('waiting_human'),
    );
    // implement resumed its session with the note; a later approved push is not asked again
    const resumed = q.calls[2];
    expect(resumed?.options.resume).toBe('sess-2');
    expect(resumed?.prompt).toContain('was granted');
  });

  it('start() suspends running nodes of a run left waiting on an approval (crash while blocked)', async () => {
    const s = setup({ claudeCode: true });
    const store = new MemoryEventStore();
    const q = fakeQuery(() => [msg.init(), msg.success('ok')]);
    const { manager: m } = manager(store, { queryFn: q, vault: s.vault });
    const { runId } = await m.submit({
      orgRoot: s.orgRoot,
      project: s.project,
      workflow: 'hello-feature',
      input: 'x',
      workspace: 'inplace',
    });
    await vi.waitFor(async () => expect((await m.state(runId)).status).toBe('waiting_human'));
    await m.stop({ force: false, graceMs: 0 });
    // forge the log of a crash: a node blocked on an approval with a live session
    const at = new Date().toISOString();
    await store.append({ type: 'HumanResponded', runId, nodeId: 'ship', at, approved: true });
    await store.append({ type: 'NodeStarted', runId, nodeId: 'implement', at });
    await store.append({
      type: 'SessionStarted',
      runId,
      nodeId: 'implement',
      at,
      runtime: 'claude-code',
      sessionId: 'crashed',
    });
    await store.append({
      type: 'ToolApprovalRequested',
      runId,
      nodeId: 'implement',
      at,
      approvalId: 'blocked',
      role: 'backend',
      tool: 'Bash',
      program: 'git',
      category: 'push',
      command: 'git push',
      argvHash: 'h',
    });
    const fresh = manager(store, { queryFn: q, vault: s.vault });
    await fresh.manager.start();
    const state = await fresh.manager.state(runId);
    expect(state.status).toBe('waiting_approval');
    expect(state.nodes.implement).toMatchObject({ status: 'pending', sessionId: 'crashed' });
    expect((await store.read(runId)).at(-1)?.type).toBe('NodeSuspended');
  });

  it('start() re-queues queued and interrupted running runs', async () => {
    const s = setup();
    const store = new MemoryEventStore();
    await store.append({
      type: 'RunCreated',
      runId: 'q1',
      at: 'x',
      workflow: 'hello-feature',
      input: { spec: 'x' },
      workspace: s.project,
      adapter: 'mock',
      workspaceMode: 'inplace',
      project: s.project,
      orgRoot: s.orgRoot,
    });
    const { manager: m } = manager(store);
    await m.start();
    await vi.waitFor(async () => expect((await m.state('q1')).status).toBe('waiting_human'));
  });

  it('start() recovers two interrupted runs and executes each exactly once', async () => {
    const s = setup();
    const store = new MemoryEventStore();
    for (const runId of ['r1', 'r2']) {
      await store.append({
        type: 'RunCreated',
        runId,
        at: 'x',
        workflow: 'hello-feature',
        input: { spec: 'x' },
        workspace: s.project,
        adapter: 'mock',
        workspaceMode: 'inplace',
        project: s.project,
        orgRoot: s.orgRoot,
      });
      await store.append({ type: 'RunStarted', runId, at: 'x' });
    }
    const { manager: m } = manager(store);
    await m.start();
    for (const runId of ['r1', 'r2']) {
      await vi.waitFor(async () => expect((await m.state(runId)).status).toBe('waiting_human'));
      const starts = (await store.read(runId)).filter((e) => e.type === 'NodeStarted');
      expect(starts.map((e) => e.nodeId)).toEqual(['analyse', 'implement', 'qa', 'judge', 'ship']);
    }
  });

  it('a run of another org starts while the head waits on its org limit', async () => {
    const a = setup();
    const b = setup();
    const store = new MemoryEventStore();
    const gates = new Map<string, () => void>();
    const { manager: m } = manager(store, {
      mockScript: (job: TaskJob) =>
        new Promise((resolve) => {
          gates.set(job.runId, () => resolve({ output: {}, summary: 'ok' }));
        }),
    });
    writeFileSync(
      join(a.orgRoot, 'org.yaml'),
      'organization: a\nbudgets: { per_run_usd: 5 }\nteams: [engineering]\nmax_concurrent_runs: 1\n',
    );
    await submitMock(m, a, 'inplace');
    const a2 = await submitMock(m, a, 'inplace');
    const b1 = await submitMock(m, b, 'inplace');
    await vi.waitFor(() => expect(gates.has(b1.runId)).toBe(true));
    expect((await m.state(a2.runId)).status).toBe('queued');
    expect(m.active()).toEqual({ running: 2, queued: 1, waiting: 0 });
  });

  it('stop() without force aborts live runs after the grace period without cancelling them', async () => {
    const s = setup();
    const store = new MemoryEventStore();
    let aborted = false;
    const { manager: m } = manager(store, {
      mockScript: (_job: TaskJob, ctx: { signal: AbortSignal }) =>
        new Promise(() => {
          ctx.signal.addEventListener('abort', () => {
            aborted = true;
          });
        }),
    });
    const { runId } = await submitMock(m, s, 'inplace');
    await vi.waitFor(async () => expect((await m.state(runId)).status).toBe('running'));
    await m.stop({ force: false, graceMs: 10 });
    expect(aborted).toBe(true);
    expect(m.active().running).toBe(0);
    expect((await m.state(runId)).status).toBe('running'); // recovered on the next start
  });

  it('start() skips a run whose org directory is gone and logs it', async () => {
    const s = setup();
    const store = new MemoryEventStore();
    await store.append({
      type: 'RunCreated',
      runId: 'gone',
      at: 'x',
      workflow: 'hello-feature',
      input: { spec: 'x' },
      workspace: s.project,
      adapter: 'mock',
      workspaceMode: 'inplace',
      project: s.project,
      orgRoot: join(s.dir, 'missing-org'),
    });
    await store.append({ type: 'RunStarted', runId: 'gone', at: 'x' });
    await store.append({ type: 'NodeStarted', runId: 'gone', nodeId: 'implement', at: 'x' });
    await store.append({
      type: 'ToolApprovalRequested',
      runId: 'gone',
      nodeId: 'implement',
      at: 'x',
      approvalId: 'g1',
      role: 'backend',
      tool: 'Bash',
      program: 'git',
      category: 'push',
      command: 'git push',
      argvHash: 'h',
    });
    const logs: string[] = [];
    const { manager: m, inbox } = manager(store, { log: (l: string) => logs.push(l) });
    await expect(m.start()).resolves.toBeUndefined();
    // suspended without needing the org; the missing org only surfaces when the run continues
    expect((await m.state('gone')).nodes.implement?.status).toBe('pending');
    await inbox.answer('approval:g1', { approved: true, via: 'cli' });
    await vi.waitFor(() =>
      expect(logs.some((l) => l.includes('gone') && l.includes('missing-org'))).toBe(true),
    );
  });

  it('resume refuses when the worktree was removed', async () => {
    const s = setup({ git: true });
    const store = new MemoryEventStore();
    const { manager: m } = manager(store);
    const { runId } = await submitMock(m, s, 'worktree');
    await vi.waitFor(async () => expect((await m.state(runId)).status).toBe('waiting_human'));
    await removeRunWorkspace({ project: s.project, runId });
    await expect(m.resume(runId, {})).rejects.toThrow(/worktree .* no longer exists/);
  });

  it('submit rejects an unknown workflow before any event', async () => {
    const s = setup();
    const store = new MemoryEventStore();
    const { manager: m } = manager(store);
    await expect(
      m.submit({ orgRoot: s.orgRoot, project: s.project, workflow: 'nope', input: 'x' }),
    ).rejects.toThrow('workflow "nope" is not defined');
    expect(await store.listRuns()).toEqual([]);
  });

  it('streams runtime events and keeps a replayable buffer', async () => {
    const s = setup();
    const store = new MemoryEventStore();
    const { manager: m } = manager(store);
    const seen: string[] = [];
    m.onRuntimeEvent((e) => seen.push(e.event.type));
    const { runId } = await submitMock(m, s, 'inplace');
    await vi.waitFor(async () => expect((await m.state(runId)).status).toBe('waiting_human'));
    expect(seen).toContain('result');
    expect(m.runtimeEvents(runId).map((e) => e.event.type)).toEqual(seen);
    expect(m.runtimeEvents(runId)[0]).toMatchObject({ runId, nodeId: 'analyse', seq: 1 });
    expect(m.runtimeEvents(runId, 2).every((e) => e.seq > 2)).toBe(true);
  });

  it('cancel aborts an active run', async () => {
    const s = setup();
    const store = new MemoryEventStore();
    const { manager: m } = manager(store, {
      mockScript: () => new Promise(() => {}),
    });
    const { runId } = await submitMock(m, s, 'inplace');
    await vi.waitFor(async () => expect((await m.state(runId)).status).toBe('running'));
    const state = await m.cancel(runId);
    expect(state.status).toBe('cancelled');
    await vi.waitFor(() => expect(m.active().running).toBe(0));
  });
});

describe('RuntimeBuffer retire', () => {
  it('drops only the oldest finished runs beyond the keep limit', async () => {
    const { RuntimeBuffer } = await import('../src/runtime-buffer.js');
    const b = new RuntimeBuffer(10, 2);
    for (const id of ['a', 'b', 'c']) {
      b.push(id, 'n', { type: 'text', text: 'x' }, 'now');
      b.retire(id);
    }
    expect(b.read('a')).toEqual([]);
    expect(b.read('b')).toHaveLength(1);
    expect(b.read('c')).toHaveLength(1);
  });

  it('stores trimmed outputs and forgets a retired run that starts again', async () => {
    const { RuntimeBuffer, STORED_TEXT_LIMIT } = await import('../src/runtime-buffer.js');
    const b = new RuntimeBuffer(10, 1);
    b.push('a', 'n', { type: 'tool_result', name: 'Read', output: 'x'.repeat(1_000_000) }, 'now');
    b.push('a', 'n', { type: 'text', text: 'y'.repeat(100_000) }, 'now');
    const [r, t] = b.read('a') as [{ event: { output: unknown } }, { event: { text: string } }];
    expect(String(r.event.output).length).toBeLessThanOrEqual(STORED_TEXT_LIMIT + 1);
    expect(t.event.text.length).toBeLessThanOrEqual(STORED_TEXT_LIMIT + 1);
    b.retire('a');
    // the run resumes: it is live again and must not be evicted by later retirements
    b.push('a', 'n', { type: 'text', text: 'again' }, 'now');
    b.push('b', 'n', { type: 'text', text: 'b' }, 'now');
    b.retire('b');
    expect(b.read('a')).toHaveLength(3);
  });
});

describe('runtime buffer after a run ends', () => {
  it('keeps the stream of a finished run so a later follow still shows it', async () => {
    const s = setup();
    const store = new MemoryEventStore();
    const { manager: m, inbox } = manager(store);
    const { runId } = await submitMock(m, s, 'inplace');
    await vi.waitFor(async () => expect((await m.state(runId)).status).toBe('waiting_human'));
    await inbox.answer(`human:${runId}:ship`, { approved: true, via: 'cli' });
    await vi.waitFor(async () => expect((await m.state(runId)).status).toBe('completed'));
    expect(m.runtimeEvents(runId).length).toBeGreaterThan(0);
  });
});
