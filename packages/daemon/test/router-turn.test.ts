import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryEventStore, type TaskJob } from '@wizardingcode/shibaox-core';
import { startFakeJev } from '@wizardingcode/shibaox-jev/testing';
import { startFakeOpenAI } from '@wizardingcode/shibaox-providers/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InboxService } from '../src/inbox.js';
import { RunManager } from '../src/run-manager.js';
import { scaffoldOrg } from '../src/templates.js';

const sample = fileURLToPath(new URL('../../../examples/sample-repo', import.meta.url));
const KEY = 'ts-secret-key-123';
const tmp: string[] = [];
const managers: RunManager[] = [];
const fakes: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const m of managers.splice(0)) await m.stop({ force: true, graceMs: 0 });
  for (const f of fakes.splice(0)) await f.close();
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** What the fake Jev answers next (intent, tier and their confidences). */
type Answer = { intent: string; ic: number; tier: string; tc: number; risky?: number } | 'broken';

async function world(o: { routing?: string; jevBase?: string; timeoutMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'route-'));
  tmp.push(dir);
  scaffoldOrg(dir);
  const orgRoot = join(dir, 'org');
  writeFileSync(
    join(orgRoot, 'models.yaml'),
    `providers: {}\ntiers: { strong: fake/strong, cheap: fake/cheap, decision: jev-latest }\nroles: {}\ngates: {}\n${o.routing ?? ''}`,
  );
  // the orchestrator on the strong tier (Andre's org), without the account's MCP
  writeFileSync(
    join(orgRoot, 'roles', 'assistant.yaml'),
    'role: assistant\ndescription: The orchestrator.\nmodel_tier: strong\ntools: [read]\n',
  );
  const project = join(dir, 'proj');
  cpSync(sample, project, { recursive: true });
  let next: Answer = { intent: 'media', ic: 0.98, tier: 'cheap', tc: 0.9 };
  const jev = await startFakeJev((req) => {
    // decide nodes of team runs (Jev decides for this org) are not routing
    if (req.questions.decision)
      return {
        decision: { type: 'choice', choice: 'ship', confidence: 0.95, probabilities: {} },
      };
    if (next === 'broken') return {};
    const a = next;
    return {
      intent: { type: 'choice', choice: a.intent, confidence: a.ic, probabilities: {} },
      tier: { type: 'choice', choice: a.tier, confidence: a.tc, probabilities: {} },
      risky: { type: 'noul', noul: a.risky ?? 0.05 },
    };
  });
  const llm = await startFakeOpenAI(() => ({ content: 'here you go' }));
  fakes.push(jev, llm);
  const logs: string[] = [];
  const jobs: TaskJob[] = [];
  const store = new MemoryEventStore();
  let m: RunManager | undefined;
  const inbox = new InboxService({
    store,
    approvalTimeoutMs: 60_000,
    onResolved: (item, a) => m?.onInboxResolved(item, a),
  });
  m = new RunManager({
    store,
    inbox,
    config: { max_concurrent_runs: 4 },
    log: (l) => logs.push(l),
    env: { TYPESAFE_API_KEY: KEY, SHIBAOX_JEV_BASE_URL: o.jevBase ?? jev.baseURL },
    ...(o.timeoutMs !== undefined ? { routerTimeoutMs: o.timeoutMs } : {}),
    vault: join(dir, 'vault'),
    mockScript: (job) => {
      jobs.push(job);
      return { output: { text: 'ok' }, summary: 'ok' };
    },
    extraProviders: [
      {
        id: 'fake',
        name: 'Fake',
        kind: 'openai-compatible',
        base_url: llm.baseURL,
        auth: { type: 'none' },
        models: ['strong', 'cheap'],
        pricing: {
          strong: { input_per_m: 1, output_per_m: 1 },
          cheap: { input_per_m: 1, output_per_m: 1 },
        },
        verify: false,
        capabilities: { tools: true },
      },
    ],
  });
  managers.push(m);
  const manager = m;
  const chat = (input: string, extra: Partial<Parameters<RunManager['submit']>[0]> = {}) =>
    manager.submit({
      orgRoot,
      project,
      workflow: 'chat',
      input,
      adapter: 'direct',
      workspace: 'inplace',
      ...extra,
    });
  const done = async (runId: string) => {
    await vi.waitFor(
      async () => expect(['completed', 'failed']).toContain((await manager.state(runId)).status),
      { timeout: 10_000 },
    );
    return manager.state(runId);
  };
  const events = async (runId: string) => store.read(runId);
  return {
    m: manager,
    jev,
    llm,
    logs,
    jobs,
    chat,
    done,
    events,
    orgRoot,
    project,
    answer: (a: Answer) => {
      next = a;
    },
  };
}

const models = (llm: { requests: unknown[] }) =>
  llm.requests.map((r) => (r as { model: string }).model);

describe('Jev routes chat turns', () => {
  it('a cheap route at ≥ 0.75 runs the turn on the cheap tier and records two jev decisions', async () => {
    const w = await world();
    const { runId } = await w.chat('make me a picture of a cat');
    const state = await w.done(runId);
    expect(state.status).toBe('completed');
    expect(state.model).toBe('fake/cheap');
    expect(models(w.llm)).toEqual(['cheap']);
    const evs = await w.events(runId);
    const decisions = evs.filter((e) => e.type === 'DecisionMade');
    expect(decisions).toMatchObject([
      { nodeId: 'router', choice: 'media', confidence: 0.98, by: 'jev' },
      { nodeId: 'router:tier', choice: 'cheap', confidence: 0.9, by: 'jev' },
    ]);
    const cost = (decisions[0] as { cost?: { usd: number } }).cost?.usd ?? 0;
    expect(cost).toBeGreaterThan(0);
    expect(state.route).toMatchObject({ intent: 'media', tier: 'cheap', by: 'jev' });
    expect(state.nodes.router).toBeUndefined();
    // the hint is the model's, the user's text is unchanged
    expect(state.input.spec).toBe('make me a picture of a cat');
    expect(state.input.router).toBe(
      '[router] intent=media (0.98) tier=cheap risky=no: generate it with Higgsfield now',
    );
    const user = JSON.stringify((w.llm.requests[0] as { messages: unknown[] }).messages);
    expect(user).toContain('[router] intent=media (0.98) tier=cheap risky=no');
    // one fan-out with the three questions, the request in the state
    expect(w.jev.requests).toHaveLength(1);
    const sent = w.jev.requests[0] as { state: string; questions: Record<string, unknown> };
    expect(Object.keys(sent.questions)).toEqual(['intent', 'tier', 'risky']);
    expect(sent.state).toContain('make me a picture of a cat');
    expect(w.logs.some((l) => l.startsWith('[router] intent=media'))).toBe(true);
    expect(w.logs.join('\n')).not.toContain(KEY);
    expect(JSON.stringify(evs)).not.toContain(KEY);
  });

  it('below the threshold, or a strong route, keeps the role default', async () => {
    const w = await world();
    w.answer({ intent: 'chat', ic: 0.9, tier: 'cheap', tc: 0.7 });
    const a = await w.done((await w.chat('hello')).runId);
    expect(a.model).toBeUndefined();
    w.answer({ intent: 'code', ic: 0.9, tier: 'strong', tc: 0.99 });
    const b = await w.done((await w.chat('refactor the parser')).runId);
    expect(b.model).toBeUndefined();
    expect(b.route).toMatchObject({ intent: 'code', tier: 'strong' });
    expect(models(w.llm)).toEqual(['strong', 'strong']);
  });

  it('cheap_min_confidence comes from models.yaml routing', async () => {
    const w = await world({ routing: 'routing: { cheap_min_confidence: 0.95 }\n' });
    w.answer({ intent: 'chat', ic: 0.9, tier: 'cheap', tc: 0.9 });
    const s = await w.done((await w.chat('hi')).runId);
    expect(s.model).toBeUndefined();
  });

  it('a model named by the request is never overridden', async () => {
    const w = await world();
    const s = await w.done((await w.chat('hi', { model: 'fake/strong' })).runId);
    expect(s.model).toBe('fake/strong');
    expect(s.route?.tier).toBe('cheap'); // still routed and recorded
    expect(models(w.llm)).toEqual(['strong']);
  });

  it('routing.jev: false turns it off: no fan-out, no decisions, no hint', async () => {
    const w = await world({ routing: 'routing: { jev: false }\n' });
    const s = await w.done((await w.chat('make a cat')).runId);
    expect(w.jev.requests).toHaveLength(0);
    expect((await w.events(s.runId)).some((e) => e.type === 'DecisionMade')).toBe(false);
    expect(s.input.router).toBeUndefined();
  });

  it('Jev failing never breaks the turn: it runs unrouted with a log line', async () => {
    const w = await world();
    w.answer('broken');
    const s = await w.done((await w.chat('make a cat')).runId);
    expect(s.status).toBe('completed');
    expect(s.model).toBeUndefined();
    expect(s.route).toBeUndefined();
    expect(s.input.router).toBeUndefined();
    expect(w.logs.some((l) => /^\[router\] .*unrouted/.test(l))).toBe(true);
    expect(w.logs.join('\n')).not.toContain(KEY);
  });

  it('never routes dispatched runs, event turns or non-conversation workflows', async () => {
    const w = await world();
    const child = await w.chat('make a cat', { parentRunId: 'p' });
    const event = await w.chat('the run ended', { event: true });
    const team = await w.m.submit({
      orgRoot: w.orgRoot,
      project: w.project,
      workflow: 'hello-feature',
      input: 'add /health',
      adapter: 'mock',
      workspace: 'inplace',
    });
    await w.done(child.runId);
    await w.done(event.runId);
    await vi.waitFor(async () =>
      expect((await w.m.state(team.runId)).status).toBe('waiting_human'),
    );
    const routing = w.jev.requests.filter(
      (r) => (r as { questions: Record<string, unknown> }).questions.intent,
    );
    expect(routing).toHaveLength(0);
  });

  it('the mock adapter gets the hint but never a model', async () => {
    const w = await world();
    const { runId } = await w.chat('make a cat', { adapter: 'mock' });
    const s = await w.done(runId);
    expect(s.model).toBeUndefined();
    expect(s.adapter).toBe('mock');
    expect(w.jobs[0]?.input.router).toMatch(/^\[router\] intent=media/);
    expect(w.jobs[0]?.input.spec).toBe('make a cat');
  });

  it('Jev too slow: the turn waits at most the router timeout, then runs unrouted', async () => {
    // a Jev that never answers
    const sockets = new Set<import('node:net').Socket>();
    const hang = createServer(() => undefined);
    hang.on('connection', (c) => sockets.add(c));
    await new Promise<void>((r) => hang.listen(0, '127.0.0.1', r));
    fakes.push({
      close: () =>
        new Promise<void>((r) => {
          for (const c of sockets) c.destroy();
          hang.close(() => r());
        }),
    });
    const a = hang.address();
    const port = typeof a === 'object' && a ? a.port : 0;
    const w = await world({ jevBase: `http://127.0.0.1:${port}`, timeoutMs: 300 });
    const t0 = Date.now();
    const { runId } = await w.chat('make a cat');
    expect(Date.now() - t0).toBeLessThan(5_000);
    const s = await w.done(runId);
    expect(s.status).toBe('completed');
    expect(s.route).toBeUndefined();
    expect(w.logs.some((l) => /^\[router\] Jev failed \(.*timed out after 300 ms\)/.test(l))).toBe(
      true,
    );
  });

  it("Telegram turns and routines' chat runs are routed too; attachment names (never contents) reach Jev", async () => {
    const w = await world();
    const tg = await w.chat('make a cat', { origin: 'telegram:42' });
    const routine = await w.chat('daily briefing', { origin: 'schedule:s1', adapter: 'mock' });
    const withFile = await w.chat('make it like this', {
      adapter: 'mock',
      attachments: [
        {
          name: 'dog.png',
          mime: 'image/png',
          content: Buffer.from('SECRET-BYTES').toString('base64'),
        },
      ],
    });
    for (const r of [tg, routine, withFile])
      expect((await w.done(r.runId)).route?.intent).toBe('media');
    const states = w.jev.requests.map((r) => (r as { state: string }).state);
    expect(states).toHaveLength(3);
    expect(states[2]).toContain('dog.png (image/png)');
    expect(states[2]).not.toContain('SECRET-BYTES');
    expect(states[2]).not.toContain(Buffer.from('SECRET-BYTES').toString('base64'));
    // the org's workflows are offered with their descriptions
    const q = (w.jev.requests[0] as { questions: { intent: { criteria: Record<string, string> } } })
      .questions.intent.criteria;
    expect(Object.keys(q)).toContain('workflow:hello-feature');
    expect(Object.keys(q)).not.toContain('workflow:chat');
  });
});
