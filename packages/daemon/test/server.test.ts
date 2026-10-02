import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { request as httpRequest } from 'node:http';
import { connect, createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryEventStore, type TaskJob } from '@wizardingcode/shibaox-core';
import { SchedulesRepo, SqliteEventStore } from '@wizardingcode/shibaox-persistence-sqlite';
import { forgetModels } from '@wizardingcode/shibaox-providers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DaemonClient, DaemonHttpError, type Envelope } from '../src/client.js';
import { Daemon } from '../src/daemon.js';
import { homePaths } from '../src/home.js';
import { registryFor } from '../src/runtime.js';
import { scaffoldOrg } from '../src/templates.js';

const sample = fileURLToPath(new URL('../../../examples/sample-repo', import.meta.url));
const tmpDirs: string[] = [];
const daemons: Daemon[] = [];
afterEach(async () => {
  forgetModels();
  for (const d of daemons.splice(0)) await d.stop({ force: true }).catch(() => undefined);
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'srv-'));
  tmpDirs.push(dir);
  scaffoldOrg(dir);
  const project = join(dir, 'proj');
  cpSync(sample, project, { recursive: true });
  const home = homePaths({ SHIBAOX_HOME: join(dir, 'home') });
  return { dir, orgRoot: join(dir, 'org'), project, home, vault: join(dir, 'vault') };
}

async function started(
  s: ReturnType<typeof setup>,
  extra: ConstructorParameters<typeof Daemon>[0] = {},
) {
  const daemon = new Daemon({
    home: s.home,
    store: new MemoryEventStore(),
    channels: [],
    env: {},
    log: () => {},
    version: '9.9.9',
    vault: s.vault,
    discovery: false, // tests never probe the developer's own local servers
    ...extra,
  });
  daemons.push(daemon);
  await daemon.start();
  return { daemon, client: new DaemonClient(s.home.socket) };
}

const submit = (client: DaemonClient, s: ReturnType<typeof setup>) =>
  client.submitRun({
    orgRoot: s.orgRoot,
    project: s.project,
    workflow: 'hello-feature',
    input: 'add /health',
    adapter: 'mock',
    workspace: 'inplace',
  });

async function collect(events: AsyncIterable<Envelope>, until: (e: Envelope) => boolean) {
  const out: Envelope[] = [];
  for await (const e of events) {
    out.push(e);
    if (until(e)) break;
  }
  return out;
}

describe('org config endpoints', () => {
  it('GET/PUT /orgs/config read and change the tiers of an org', async () => {
    const s = setup();
    const { client } = await started(s);
    const before = await client.orgConfig(s.orgRoot);
    expect(before.tiers.strong).toBe('anthropic/claude-sonnet-5');
    const after = await client.setOrgConfig(s.orgRoot, {
      tiers: { strong: 'openrouter/openai/gpt-5' },
    });
    expect(after.tiers.strong).toBe('openrouter/openai/gpt-5');
    expect((await client.orgConfig(s.orgRoot)).tiers.strong).toBe('openrouter/openai/gpt-5');
    await expect(
      client.setOrgConfig(s.orgRoot, { tiers: { strong: 'bad' } }),
    ).rejects.toMatchObject({
      status: 400,
    });
  });
  it('PUT /orgs/config turns Jev routing off and on', async () => {
    const s = setup();
    const { client } = await started(s);
    const off = await client.setOrgConfig(s.orgRoot, { routing: { jev: false } });
    expect(off.routing).toEqual({ jev: false });
    expect((await client.orgConfig(s.orgRoot)).routing).toEqual({ jev: false });
    await expect(
      client.setOrgConfig(s.orgRoot, { routing: { cheap_min_confidence: 3 } }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('default org', () => {
  it('GET /orgs/default names the org under the shibaox home and creates it when missing', async () => {
    const s = setup();
    const { client } = await started(s, { claudeInstalled: false });
    const r = await client.defaultOrg();
    expect(r.root).toBe(join(s.home.root, 'org'));
    expect(existsSync(join(r.root, 'org.yaml'))).toBe(true);
    expect(existsSync(join(s.home.root, 'vault'))).toBe(true);
  });
});

describe('keys endpoints', () => {
  it('PUT/GET/DELETE /keys manage the vault and the daemon uses a new key at once', async () => {
    const s = setup();
    const { client } = await started(s, { env: {} });
    expect((await client.models()).find((m) => m.ref === 'openai/gpt-5')?.configured).toBe(false);
    await client.setKey('OPENAI_API_KEY', 'sk-test-1234567890');
    const keys = await client.keys();
    expect(keys.find((k) => k.name === 'OPENAI_API_KEY')).toMatchObject({
      set: true,
      source: 'vault',
      masked: '…7890',
    });
    expect(JSON.stringify(keys)).not.toContain('sk-test-1234567890');
    // no restart: the models list already sees the provider as configured
    expect((await client.models()).find((m) => m.ref === 'openai/gpt-5')?.configured).toBe(true);
    await client.unsetKey('OPENAI_API_KEY');
    expect((await client.keys()).find((k) => k.name === 'OPENAI_API_KEY')?.set).toBe(false);
    expect((await client.models()).find((m) => m.ref === 'openai/gpt-5')?.configured).toBe(false);
    await expect(client.setKey('bad name', 'x')).rejects.toMatchObject({ status: 400 });
    await expect(client.setKey('HIGGSFIELD_API_KEY', 'nocolon')).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/paste it as-is/),
    });
    expect((await client.keys()).find((k) => k.name === 'HIGGSFIELD_API_KEY')?.set).toBe(false);
    await expect(
      client.setKey('SHIBAOX_HIGGSFIELD_API_BASE', 'http://other.test'),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/reserved for Shibaox's own settings/),
    });
  });
});

describe('models endpoint', () => {
  it('GET /models lists the catalog refs with whether they are configured', async () => {
    const s = setup();
    const { client } = await started(s, { env: { ANTHROPIC_API_KEY: 'k' } });
    const models = await client.models();
    const sonnet = models.find((m) => m.ref === 'anthropic/claude-sonnet-5');
    expect(sonnet).toEqual({
      ref: 'anthropic/claude-sonnet-5',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      configured: true,
      pricing: { input_per_m: 3, output_per_m: 15 },
      contextWindow: 200000,
    });
    expect(models.find((m) => m.ref === 'anthropic-subscription/claude-haiku-4-5')).toMatchObject({
      configured: true,
      runtime: 'claude-code',
    });
    expect(models.find((m) => m.ref === 'openai/gpt-5')).toMatchObject({
      configured: false,
      missing: ['OPENAI_API_KEY'],
    });
    // local servers are asked what they have; catalog entries stay listed either way
    expect(models.find((m) => m.ref === 'ollama/llama3.2')).toMatchObject({
      local: true,
      configured: true,
    });
  });
});

describe('project profile endpoint', () => {
  it('GET /projects/profile profiles a directory and writes the vault note', async () => {
    const s = setup();
    const { client } = await started(s);
    const p = await client.projectProfile(s.project, s.orgRoot);
    expect(p.summary).toContain('files');
    expect(p.stack).toContain('JavaScript');
    expect(existsSync(join(s.vault, '10-projects', 'proj', 'profile.md'))).toBe(true);
    await expect(client.projectProfile('', s.orgRoot)).rejects.toThrow(DaemonHttpError);
    await expect(client.projectProfile(join(s.dir, 'missing'))).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('daemon server and client', () => {
  it('health, submit, events and completion through the client', async () => {
    const s = setup();
    const { client } = await started(s);
    expect(await client.health()).toMatchObject({ version: '9.9.9', runs: { running: 0 } });
    const { runId, warnings } = await submit(client, s);
    expect(warnings).toEqual([expect.stringContaining('no decider model configured')]);
    const seen = await collect(
      client.events(runId),
      (e) => e.kind === 'run' && e.event.type === 'HumanRequested',
    );
    expect(
      seen
        .filter((e) => e.kind === 'run')
        .map((e) => e.event.type)
        .slice(0, 3),
    ).toEqual(['RunCreated', 'RunStarted', 'NodeStarted']);
    expect(seen.some((e) => e.kind === 'runtime' && e.event.event.type === 'result')).toBe(true);
    const inbox = await client.inbox();
    expect(inbox).toMatchObject([{ id: `human:${runId}:ship`, kind: 'human' }]);
    await client.answer(inbox[0]?.id ?? '', { approved: true });
    const rest = await collect(
      client.events(runId, { since: seen.at(-1)?.cursor }),
      (e) => e.kind === 'end',
    );
    expect(rest.at(-1)).toMatchObject({ kind: 'end', status: 'completed' });
    expect((await client.getRun(runId)).status).toBe('completed');
    expect((await client.listRuns()).map((r) => r.runId)).toEqual([runId]);
    expect(await client.listRuns({ status: 'running' })).toEqual([]);
  });

  it('second answer gets 409', async () => {
    const s = setup();
    const { client } = await started(s);
    const { runId } = await submit(client, s);
    await vi.waitFor(async () => expect((await client.inbox()).length).toBe(1));
    await client.answer(`human:${runId}:ship`, { approved: false, note: 'no' });
    const err = await client
      .answer(`human:${runId}:ship`, { approved: true })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonHttpError);
    expect((err as DaemonHttpError).status).toBe(409);
    expect((err as DaemonHttpError).code).toBe('already_resolved');
    const missing = await client
      .answer('approval:nope', { approved: true })
      .catch((e: unknown) => e);
    expect((missing as DaemonHttpError).status).toBe(404);
    await vi.waitFor(async () => expect((await client.getRun(runId)).status).toBe('cancelled'));
  });

  it('replaces a stale socket file', async () => {
    const s = setup();
    writeFileSync(s.home.socket, '');
    const { client } = await started(s);
    expect((await client.health()).version).toBe('9.9.9');
  });

  it('refuses to start when another daemon owns the socket', async () => {
    const s = setup();
    await started(s);
    const second = new Daemon({
      home: s.home,
      store: new MemoryEventStore(),
      channels: [],
      env: {},
      log: () => {},
    });
    await expect(second.start()).rejects.toThrow('already running');
  });

  it('client disconnect does not cancel the run', async () => {
    const s = setup();
    let release: (() => void) | undefined;
    const { client } = await started(s, {
      mockScript: (job: TaskJob) =>
        job.nodeId === 'analyse'
          ? new Promise((resolve) => {
              release = () => resolve({ output: {}, summary: 'ok' });
            })
          : { output: {}, summary: 'ok' },
    });
    const { runId } = await submit(client, s);
    const ac = new AbortController();
    const it = client.events(runId, { signal: ac.signal })[Symbol.asyncIterator]();
    await it.next();
    ac.abort();
    await vi.waitFor(() => expect(release).toBeDefined());
    release?.();
    await vi.waitFor(async () => expect((await client.getRun(runId)).status).toBe('waiting_human'));
  });

  it('POST /runs with an unknown workflow is 400 and writes no event', async () => {
    const s = setup();
    const { client } = await started(s);
    const err = await client
      .submitRun({ orgRoot: s.orgRoot, project: s.project, workflow: 'nope', input: 'x' })
      .catch((e: unknown) => e);
    expect((err as DaemonHttpError).status).toBe(400);
    expect((err as DaemonHttpError).message).toContain('workflow "nope" is not defined');
    expect(await client.listRuns()).toEqual([]);
  });

  it('resume of a run waiting on an approval is 409 with the approve hint', async () => {
    const s = setup();
    const { daemon, client } = await started(s);
    const { runId } = await submit(client, s);
    await vi.waitFor(async () => expect((await client.getRun(runId)).status).toBe('waiting_human'));
    // forge a pending approval on the log
    await daemon.store.append({
      type: 'ToolApprovalRequested',
      runId,
      nodeId: 'implement',
      at: 'x',
      approvalId: 'ap1',
      role: 'backend',
      tool: 'Bash',
      program: 'git',
      category: 'push',
      command: 'git push',
      argvHash: 'h',
    });
    const err = await client.resume(runId).catch((e: unknown) => e);
    expect((err as DaemonHttpError).status).toBe(409);
    expect((err as DaemonHttpError).message).toContain('shibaox approve approval:ap1');
    expect((await client.getRun('nope').catch((e: unknown) => e)) as DaemonHttpError).toMatchObject(
      { status: 404 },
    );
  });

  it('schedules round-trip through the API (SQLite store)', async () => {
    const s = setup();
    const { client } = await started(s, { store: undefined });
    const row = await client.addSchedule({
      cron: '0 9 * * 1-5',
      orgRoot: s.orgRoot,
      project: s.project,
      workflow: 'hello-feature',
      input: 'daily',
      adapter: 'mock',
    });
    expect(row).toMatchObject({ cron: '0 9 * * 1-5', enabled: true });
    expect((await client.schedules()).map((r) => r.id)).toEqual([row.id]);
    const { runId } = await client.runSchedule(row.id);
    expect((await client.getRun(runId)).workflow).toBe('hello-feature');
    await client.removeSchedule(row.id);
    expect(await client.schedules()).toEqual([]);
    const bad = await client
      .addSchedule({
        cron: 'nope',
        orgRoot: s.orgRoot,
        project: s.project,
        workflow: 'hello-feature',
        input: '',
      })
      .catch((e: unknown) => e);
    expect((bad as DaemonHttpError).status).toBe(400);
    expect((bad as DaemonHttpError).message).toContain('invalid cron expression');
  });

  it('cancel and shutdown', async () => {
    const s = setup();
    const { daemon, client } = await started(s, { mockScript: () => new Promise(() => {}) });
    const { runId } = await submit(client, s);
    await vi.waitFor(async () => expect((await client.getRun(runId)).status).toBe('running'));
    expect((await client.cancel(runId)).status).toBe('cancelled');
    await client.shutdown({ force: true });
    await vi.waitFor(() => expect(existsSync(s.home.socket)).toBe(false));
    expect(existsSync(s.home.pid)).toBe(false);
    daemons.splice(daemons.indexOf(daemon), 1);
    await new Promise<void>((resolve) => {
      const sock = connect(s.home.socket);
      sock.on('error', () => resolve());
      sock.on('connect', () => {
        sock.destroy();
        resolve();
      });
    });
  });
});

describe('model discovery at start', () => {
  it('warms what the local servers and OpenRouter know so the first run has real cost and context', async () => {
    const { createServer } = await import('node:http');
    let listings = 0;
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/models') {
        listings++;
        return res.end(JSON.stringify({ data: [{ id: 'qwen3' }] }));
      }
      if (req.url === '/api/v0/models')
        return res.end(JSON.stringify({ data: [{ id: 'qwen3', loaded_context_length: 8192 }] }));
      res.statusCode = 404;
      res.end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      const s = setup();
      const { daemon } = await started(s, {
        discovery: true,
        extraProviders: [
          {
            id: 'lmstudio-test',
            name: 'LM Studio (test)',
            kind: 'openai-compatible',
            base_url: `http://127.0.0.1:${port}/v1`,
            auth: { type: 'none' },
            models: [],
            pricing: {},
            verify: false,
            context_window: {},
            capabilities: { tools: true },
          },
        ],
      });
      // asked while the warm-up is still running: one discovery, shared
      await Promise.all([daemon.models(), daemon.models()]);
      expect(listings).toBe(1);
      await vi.waitFor(
        () => expect(registryFor({}).contextWindow('lmstudio-test/qwen3')).toBe(8192),
        { timeout: 5000 },
      );
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('orgSummarizer', () => {
  it('uses the cheap tier when callable, else strong, else the run model; caps the output, strips thinking, times out', async () => {
    const { startFakeOpenAI } = await import('@wizardingcode/shibaox-providers/testing');
    const { orgSummarizer } = await import('../src/runs/summarize.js');
    const { ProviderRegistry } = await import('@wizardingcode/shibaox-providers');
    const { loadOrg } = await import('@wizardingcode/shibaox-schemas');
    const fake = await startFakeOpenAI(() => ({
      content: '<think>hmm</think>\nThey agreed on /health.',
    }));
    try {
      const entry = {
        id: 'fake',
        name: 'Fake',
        kind: 'openai-compatible' as const,
        base_url: fake.baseURL,
        auth: { type: 'none' as const },
        models: ['m'],
        pricing: {},
        verify: false,
        context_window: {},
        capabilities: { tools: true },
      };
      const s = setup();
      const org = loadOrg(s.orgRoot); // tiers: anthropic/claude-sonnet-5 (no key), ollama/llama3.2 (nothing listens)
      const registry = () => new ProviderRegistry([entry], {});
      // neither tier is known to this registry, and there is no run model: no summariser
      expect(orgSummarizer(registry)(org, undefined)).toBeUndefined();
      // the run's own model is the fallback
      const summarize = orgSummarizer(registry)(org, 'fake/m');
      expect(summarize).toBeDefined();
      expect(await summarize?.('User: hi\nAssistant: hello')).toBe('They agreed on /health.');
      const req = fake.requests[0] as { max_tokens?: number; max_completion_tokens?: number };
      expect(req.max_tokens ?? req.max_completion_tokens).toBe(600);
    } finally {
      await fake.close();
    }
  });
  it('keepThread keeps the leading summary when the thread is cut to its last turns', async () => {
    const { keepThread } = await import('../src/daemon.js');
    const t = [
      { role: 'user' as const, content: 'S', summary: true },
      ...Array.from({ length: 50 }, (_, i) => ({ role: 'user' as const, content: String(i) })),
    ];
    const kept = keepThread(t, 40);
    expect(kept).toHaveLength(40);
    expect(kept[0]).toEqual({ role: 'user', content: 'S', summary: true });
    expect(kept.at(-1)).toEqual({ role: 'user', content: '49' });
  });
});

describe('changeDescriber', () => {
  it('writes a commit message from the diff with the cheap tier and strips thinking', async () => {
    const { startFakeOpenAI } = await import('@wizardingcode/shibaox-providers/testing');
    const { changeDescriber } = await import('../src/runs/summarize.js');
    const { ProviderRegistry } = await import('@wizardingcode/shibaox-providers');
    const { loadOrg } = await import('@wizardingcode/shibaox-schemas');
    const fake = await startFakeOpenAI(() => ({
      content: '<think>x</think>feat: add hello\n\nAdds hello.txt.',
    }));
    try {
      const entry = {
        id: 'fake',
        name: 'Fake',
        kind: 'openai-compatible' as const,
        base_url: fake.baseURL,
        auth: { type: 'none' as const },
        models: ['m'],
        pricing: {},
        verify: false,
        context_window: {},
        capabilities: { tools: true },
      };
      const s = setup();
      const org = loadOrg(s.orgRoot);
      const describe = changeDescriber(() => new ProviderRegistry([entry], {}))(org, 'fake/m');
      expect(describe).toBeDefined();
      const text = await describe?.({
        kind: 'commit',
        spec: 'add hello',
        summaries: [],
        diff: '+hello',
      });
      expect(text).toBe('feat: add hello\n\nAdds hello.txt.');
      const req = fake.requests[0] as { messages: { role: string; content: string }[] };
      expect(req.messages.find((m) => m.role === 'system')?.content).toMatch(/commit message/i);
      expect(req.messages.find((m) => m.role === 'user')?.content).toContain('+hello');
    } finally {
      await fake.close();
    }
  });
});

describe('a remote listener (TCP with a bearer token)', () => {
  const listen = { host: '127.0.0.1', port: 0, token_env: 'SHIBAOX_DAEMON_TOKEN' };
  it('serves the same API over TCP to a client with the token; refuses the rest', async () => {
    const s = setup();
    const { daemon } = await started(s, {
      env: { SHIBAOX_DAEMON_TOKEN: 'secret-1' },
      config: {
        max_concurrent_runs: 2,
        approval_timeout_minutes: 1,
        channels: { macos: { enabled: false } },
        listen,
      },
    });
    const addr = daemon.listenAddress();
    expect(addr).toMatchObject({ host: '127.0.0.1' });
    expect(addr?.port).toBeGreaterThan(0);
    const remote = new DaemonClient({
      baseUrl: `http://127.0.0.1:${addr?.port}`,
      token: 'secret-1',
    });
    expect((await remote.health()).version).toBe('9.9.9');
    const { runId } = await remote.submitRun({
      orgRoot: s.orgRoot,
      project: s.project,
      workflow: 'hello-feature',
      input: 'over tcp',
      adapter: 'mock',
      workspace: 'inplace',
    });
    const seen = await collect(
      remote.events(runId),
      (e) => e.kind === 'run' && e.event.type === 'HumanRequested',
    );
    expect(seen.some((e) => e.kind === 'runtime')).toBe(true);
    const inbox = await remote.inbox();
    expect(inbox).toMatchObject([{ id: `human:${runId}:ship` }]);
    await remote.answer(inbox[0]?.id ?? '', { approved: true });
    const rest = await collect(
      remote.events(runId, { since: seen.at(-1)?.cursor }),
      (e) => e.kind === 'end',
    );
    expect(rest.at(-1)).toMatchObject({ kind: 'end', status: 'completed' });
    expect((await remote.listRuns()).some((r) => r.runId === runId)).toBe(true);
    // a wrong token, or none: 401 everywhere but a reduced /health
    const wrong = new DaemonClient({ baseUrl: `http://127.0.0.1:${addr?.port}`, token: 'nope' });
    await expect(wrong.listRuns()).rejects.toMatchObject({ status: 401 });
    await expect(wrong.health()).rejects.toMatchObject({ status: 401 }); // a wrong token is told at once
    const anonymous = new DaemonClient({ baseUrl: `http://127.0.0.1:${addr?.port}` });
    await expect(anonymous.listRuns()).rejects.toMatchObject({ status: 401 });
    expect(await anonymous.health()).toEqual({ version: '9.9.9' });
    // the socket keeps working without any token
    expect((await new DaemonClient(s.home.socket).health()).version).toBe('9.9.9');
  });
  it('refuses to listen without a token, and listens nowhere without `listen`', async () => {
    const s = setup();
    const daemon = new Daemon({
      home: s.home,
      store: new MemoryEventStore(),
      channels: [],
      env: {},
      log: () => {},
      version: '9.9.9',
      vault: s.vault,
      discovery: false,
      config: {
        max_concurrent_runs: 2,
        approval_timeout_minutes: 1,
        channels: { macos: { enabled: false } },
        listen,
      },
    });
    daemons.push(daemon);
    await expect(daemon.start()).rejects.toThrow(/SHIBAOX_DAEMON_TOKEN/);
    const s2 = setup();
    const { daemon: local } = await started(s2);
    expect(local.listenAddress()).toBeUndefined();
  });
});

describe('what a dashboard without a local disk asks the daemon', () => {
  it('GET /orgs/info describes an org: workflows, conversations, adapter, subscription', async () => {
    const s = setup();
    const { client } = await started(s);
    const info = await client.orgInfo(s.orgRoot);
    expect(info.workflows).toContain('hello-feature');
    expect(info.subscription).toBe(false);
    expect(Array.isArray(info.single)).toBe(true);
    await expect(client.orgInfo(join(s.dir, 'nowhere'))).rejects.toMatchObject({ status: 404 });
    await expect(client.orgInfo('')).rejects.toMatchObject({ status: 400 });
  });
  it('GET /projects lists the configured projects, then recent ones, then the home workspace (created)', async () => {
    const s = setup();
    const { client } = await started(s, {
      config: {
        max_concurrent_runs: 2,
        approval_timeout_minutes: 1,
        channels: { macos: { enabled: false } },
        projects: ['/cfg/a', s.project],
      },
    });
    await submit(client, s);
    const workspace = join(s.home.root, 'workspace');
    expect(existsSync(workspace)).toBe(true); // created at start: a run may target it at once
    expect(await client.projects()).toEqual([
      { path: '/cfg/a', source: 'config' },
      { path: s.project, source: 'config' },
      { path: workspace, source: 'workspace' },
    ]);
    expect(existsSync(workspace)).toBe(true);
    const s2 = setup();
    const { client: c2 } = await started(s2);
    await submit(c2, s2);
    expect(await c2.projects()).toEqual([
      { path: s2.project, source: 'recent' },
      { path: join(s2.home.root, 'workspace'), source: 'workspace' },
    ]);
  });
  it('projects_dir offers every git repository directly inside it (a mounted /projects)', async () => {
    const s = setup();
    const repos = join(s.dir, 'repos');
    mkdirSync(join(repos, 'b', '.git'), { recursive: true });
    mkdirSync(join(repos, 'a', '.git'), { recursive: true });
    mkdirSync(join(repos, 'not-a-repo'), { recursive: true });
    writeFileSync(join(repos, 'file.txt'), '');
    const { client } = await started(s, {
      config: {
        max_concurrent_runs: 2,
        approval_timeout_minutes: 1,
        channels: { macos: { enabled: false } },
        projects: [],
        projects_dir: repos,
      },
    });
    expect((await client.projects()).map((p) => [p.path, p.source])).toEqual([
      [join(repos, 'a'), 'config'],
      [join(repos, 'b'), 'config'],
      [join(s.home.root, 'workspace'), 'workspace'],
    ]);
  });
});

describe('the fix pass of the remote daemon', () => {
  it('a network listener that cannot open leaves nothing behind: start rejects and the socket is closed', async () => {
    const taken = createNetServer();
    await new Promise<void>((r) => taken.listen(0, '127.0.0.1', r));
    const port = (taken.address() as { port: number }).port;
    try {
      const s = setup();
      const daemon = new Daemon({
        home: s.home,
        store: new MemoryEventStore(),
        channels: [],
        env: { SHIBAOX_DAEMON_TOKEN: 't' },
        log: () => {},
        version: '9.9.9',
        vault: s.vault,
        discovery: false,
        config: {
          max_concurrent_runs: 2,
          approval_timeout_minutes: 1,
          channels: { macos: { enabled: false } },
          projects: [],
          listen: { host: '127.0.0.1', port, token_env: 'SHIBAOX_DAEMON_TOKEN' },
        },
      });
      daemons.push(daemon);
      await expect(daemon.start()).rejects.toThrow(/EADDRINUSE/);
      expect(existsSync(s.home.socket)).toBe(false);
      await expect(new DaemonClient(s.home.socket).health()).rejects.toBeInstanceOf(Error);
      expect(daemon.listenAddress()).toBeUndefined();
    } finally {
      await new Promise<void>((r) => taken.close(() => r()));
    }
  });

  it('POST /runs refuses an empty project or org (an empty path would be the daemon cwd)', async () => {
    const s = setup();
    const { client } = await started(s);
    await expect(
      client.submitRun({ orgRoot: s.orgRoot, project: '', workflow: 'hello-feature', input: 'x' }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      client.submitRun({ orgRoot: '', project: s.project, workflow: 'hello-feature', input: 'x' }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      client.submitRun({
        orgRoot: s.orgRoot,
        project: s.project,
        workflow: 'hello-feature',
        input: 'x',
        setup: ' ',
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('the event stream carries a heartbeat comment while a run waits, so proxies keep it open', async () => {
    const s = setup();
    const { client, daemon } = await started(s, { heartbeatMs: 30 });
    const { runId } = await submit(client, s);
    await collect(
      client.events(runId),
      (e) => e.kind === 'run' && e.event.type === 'HumanRequested',
    );
    const raw = await new Promise<string>((resolve, reject) => {
      const req = httpRequest(
        { socketPath: s.home.socket, path: `/runs/${runId}/events`, method: 'GET' },
        (res) => {
          let buf = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => {
            buf += c;
            if ((buf.match(/: ping/g) ?? []).length >= 2) {
              req.destroy();
              resolve(buf);
            }
          });
          res.on('error', () => resolve(buf));
        },
      );
      req.on('error', () => undefined);
      setTimeout(() => reject(new Error('no heartbeat')), 3000);
      req.end();
    });
    expect(raw).toContain(': ping');
    expect(daemon.listenAddress()).toBeUndefined();
  });
});

describe('pruning old runs', () => {
  it('POST /runs/prune removes finished runs older than `before` and needs a date', async () => {
    const s = setup();
    const { client } = await started(s);
    const { runId } = await submit(client, s);
    await collect(
      client.events(runId),
      (e) => e.kind === 'run' && e.event.type === 'HumanRequested',
    );
    await client.answer(`human:${runId}:ship`, { approved: true });
    await collect(client.events(runId), (e) => e.kind === 'end');
    expect(await client.pruneRuns('2000-01-01T00:00:00.000Z')).toEqual({ removed: [] });
    // a date in another notation is normalised, never compared as text
    expect(await client.pruneRuns('Jan 1 2020')).toEqual({ removed: [] });
    expect(await client.pruneRuns('2000-01-01T05:00:00+05:00')).toEqual({ removed: [] });
    expect(await client.pruneRuns('9999-01-01T00:00:00.000Z')).toEqual({ removed: [runId] });
    expect(await client.listRuns()).toEqual([]);
    await expect(client.pruneRuns('not a date')).rejects.toMatchObject({ status: 400 });
  });
});

describe('GET /runs/:id/audit', () => {
  it('answers the audit as JSON or Markdown, with the tool calls, and 404 for an unknown run', async () => {
    const s = setup();
    const { client } = await started(s);
    const { runId } = await submit(client, s);
    await collect(
      client.events(runId),
      (e) => e.kind === 'run' && e.event.type === 'HumanRequested',
    );
    await client.answer(`human:${runId}:ship`, { approved: true, note: 'yes', via: 'api' });
    await collect(client.events(runId), (e) => e.kind === 'end');
    const doc = await client.audit(runId);
    expect(doc).toMatchObject({ runId, workflow: 'hello-feature', status: 'completed' });
    expect(doc.approvals).toEqual([
      expect.objectContaining({ kind: 'human', approved: true, note: 'yes', via: 'api' }),
    ]);
    expect(doc.nodes.some((n) => n.toolCalls.length > 0 || n.type === 'task')).toBe(true);
    const md = await client.auditMarkdown(runId);
    expect(md).toContain(`# Run ${runId}`);
    await expect(client.audit('nope')).rejects.toMatchObject({ status: 404 });
  });
});

describe('history after a restart', () => {
  it('a daemon restarted over the same SQLite file replays a finished run with its tool calls', async () => {
    const s = setup();
    const db = join(s.dir, 'events.db');
    const first = new Daemon({
      home: s.home,
      store: new SqliteEventStore(db),
      channels: [],
      env: {},
      log: () => {},
      version: '9.9.9',
      vault: s.vault,
      discovery: false,
    });
    daemons.push(first);
    await first.start();
    const client = new DaemonClient(s.home.socket);
    const { runId } = await submit(client, s);
    await collect(
      client.events(runId),
      (e) => e.kind === 'run' && e.event.type === 'HumanRequested',
    );
    await client.answer(`human:${runId}:ship`, { approved: true });
    await collect(client.events(runId), (e) => e.kind === 'end');
    const before = (
      await collect(client.events(runId, { historyOnly: true }), (e) => e.kind === 'end')
    )
      .filter((e) => e.kind === 'runtime')
      .map((e) => e.event.seq);
    expect(before.length).toBeGreaterThan(0);
    await first.stop({ force: true });
    const second = new Daemon({
      home: s.home,
      store: new SqliteEventStore(db),
      channels: [],
      env: {},
      log: () => {},
      version: '9.9.9',
      vault: s.vault,
      discovery: false,
    });
    daemons.push(second);
    await second.start();
    const after = (
      await collect(client.events(runId, { historyOnly: true }), (e) => e.kind === 'end')
    )
      .filter((e) => e.kind === 'runtime')
      .map((e) => e.event.seq);
    expect(after).toEqual(before);
    expect((await client.audit(runId)).nodes.some((n) => n.type === 'task')).toBe(true);
    // a reconnect after a cursor gets only what follows it, from the store too
    const frames = await collect(
      client.events(runId, { historyOnly: true }),
      (e) => e.kind === 'end',
    );
    const cursor = frames.filter((e) => e.kind === 'runtime')[1]?.cursor;
    const rest = (
      await collect(
        client.events(runId, { historyOnly: true, since: cursor }),
        (e) => e.kind === 'end',
      )
    )
      .filter((e) => e.kind === 'runtime')
      .map((e) => e.event.seq);
    expect(rest).toEqual(before.slice(2));
  });
});

describe('routines through the API', () => {
  it('add, list, get, pause/resume, run now, remove; the schedules alias keeps working on the same rows', async () => {
    const s = setup();
    const { client } = await started(s, { store: undefined });
    const r = await client.addRoutine({
      trigger: { type: 'cron', cron: '0 9 * * 1-5' },
      orgRoot: s.orgRoot,
      project: s.project,
      workflow: 'hello-feature',
      input: 'daily',
      adapter: 'mock',
      name: 'Daily',
    });
    expect(r).toMatchObject({
      trigger: { type: 'cron', cron: '0 9 * * 1-5' },
      enabled: true,
      mode: 'always',
      intervalS: 120,
      source: 'api',
    });
    expect((await client.routines()).map((x) => x.id)).toEqual([r.id]);
    expect((await client.routine(r.id)).name).toBe('Daily');
    expect((await client.pauseRoutine(r.id)).enabled).toBe(false);
    expect((await client.resumeRoutine(r.id)).enabled).toBe(true);
    const { runId } = await client.runRoutine(r.id);
    expect((await client.getRun(runId)).workflow).toBe('hello-feature');
    expect((await client.getRun(runId)).origin).toBe(`routine:${r.id}`);
    // the old shape: a cron routine reads as a schedule
    expect((await client.schedules()).map((x) => [x.id, x.cron])).toEqual([[r.id, '0 9 * * 1-5']]);
    const w = await client.addRoutine({
      trigger: { type: 'github', watch: 'issues', repo: 'acme/app', label: 'bug' },
      orgRoot: s.orgRoot,
      project: s.project,
      workflow: 'hello-feature',
      input: 'fix',
    });
    expect(w.mode).toBe('on_change');
    expect((await client.schedules()).map((x) => x.id)).toEqual([r.id]); // watchers are not schedules
    await client.removeRoutine(r.id);
    await client.removeRoutine(w.id);
    expect(await client.routines()).toEqual([]);
    await expect(client.routine('nope')).rejects.toMatchObject({ status: 404 });
    await expect(
      client.addRoutine({
        trigger: { type: 'cron', cron: 'nope' },
        orgRoot: s.orgRoot,
        project: s.project,
        workflow: 'hello-feature',
        input: '',
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      client.addRoutine({
        trigger: { type: 'nope' } as never,
        orgRoot: s.orgRoot,
        project: s.project,
        workflow: 'hello-feature',
        input: '',
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
  it('sync reads org/routines/*.yaml and the daemon migrates an old schedules table at start', async () => {
    const s = setup();
    mkdirSync(join(s.orgRoot, 'routines'), { recursive: true });
    writeFileSync(
      join(s.orgRoot, 'routines', 'nightly.yaml'),
      'routine: nightly\non: { cron: "0 2 * * *" }\nworkflow: hello-feature\ninput: nightly\nproject: ../proj\n',
    );
    const db = join(s.dir, 'events.db');
    const old = new SchedulesRepo(new SqliteEventStore(db).db);
    old.add({
      id: 'legacy',
      cron: '0 8 * * *',
      orgRoot: s.orgRoot,
      project: s.project,
      workflow: 'hello-feature',
      input: 'old',
      enabled: true,
    });
    const { client } = await started(s, { store: new SqliteEventStore(db) });
    expect((await client.routines()).map((x) => x.id)).toEqual(['legacy']);
    expect(await client.syncRoutines(s.orgRoot)).toEqual({
      added: ['nightly'],
      updated: [],
      removed: [],
    });
    expect((await client.routine('nightly')).project).toBe(s.project);
  });
});

describe('routines: what the network may add', () => {
  it('command and file triggers are refused over TCP, private URLs everywhere; the schedules alias touches cron rows only', async () => {
    const s = setup();
    const { daemon, client } = await started(s, {
      store: undefined,
      env: { SHIBAOX_DAEMON_TOKEN: 'secret-1' },
      config: {
        max_concurrent_runs: 2,
        approval_timeout_minutes: 1,
        channels: { macos: { enabled: false } },
        projects: [],
        listen: { host: '127.0.0.1', port: 0, token_env: 'SHIBAOX_DAEMON_TOKEN' },
      },
    });
    const addr = daemon.listenAddress();
    const remote = new DaemonClient({
      baseUrl: `http://127.0.0.1:${addr?.port}`,
      token: 'secret-1',
    });
    const common = {
      orgRoot: s.orgRoot,
      project: s.project,
      workflow: 'hello-feature',
      input: 'x',
    };
    await expect(
      remote.addRoutine({
        ...common,
        trigger: { type: 'command', command: 'cat ~/.shibaox/secrets.json' },
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      remote.addRoutine({ ...common, trigger: { type: 'file', path: '/etc/passwd' } }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      remote.addRoutine({
        ...common,
        trigger: { type: 'url', url: 'http://169.254.169.254/latest/meta-data' },
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      client.addRoutine({
        ...common,
        trigger: { type: 'url', url: 'http://127.0.0.1:7433/health' },
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      client.addRoutine({ ...common, trigger: { type: 'url', url: 'ftp://x.test/a' } }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      client.addRoutine({ ...common, trigger: { type: 'cron', cron: '* * * * *' }, intervalS: 5 }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      client.addRoutine({
        ...common,
        trigger: { type: 'cron', cron: '* * * * *' },
        maxDailyUsd: 0,
      }),
    ).rejects.toMatchObject({ status: 400 });
    const local = await client.addRoutine({
      ...common,
      trigger: { type: 'command', command: 'echo ok' },
    }); // the socket may
    const cron = await remote.addRoutine({
      ...common,
      trigger: { type: 'cron', cron: '* * * * *' },
    });
    expect((await client.schedules()).map((x) => x.id)).toEqual([cron.id]);
    await expect(client.removeSchedule(local.id)).rejects.toMatchObject({ status: 404 });
    await expect(client.runSchedule(local.id)).rejects.toMatchObject({ status: 404 });
    await client.removeSchedule(cron.id);
    expect(await client.schedules()).toEqual([]);
  });
});

describe('steering through the API', () => {
  it("POST /runs/:id/steer redirects the running task; GET /runs?parent= lists a run's children", async () => {
    const s = setup();
    let release: (() => void) | undefined;
    const { client } = await started(s, {
      mockScript: async (job: TaskJob) => {
        if (job.nodeId === 'implement' && !job.resumeNote) {
          await new Promise<void>((r) => {
            release = r;
          });
        }
        return { output: { heard: job.resumeNote ?? null }, summary: job.nodeId };
      },
    });
    const { runId } = await submit(client, s);
    await vi.waitFor(async () =>
      expect((await client.getRun(runId)).nodes.implement?.status).toBe('running'),
    );
    const steered = await client.steer(runId, { note: 'Use the other API', via: 'api' });
    expect(steered.nodes.implement?.steering).toEqual([
      expect.objectContaining({ note: 'Use the other API', via: 'api' }),
    ]);
    await vi.waitFor(async () => expect((await client.getRun(runId)).status).toBe('waiting_human'));
    expect((await client.getRun(runId)).nodes.implement?.output).toMatchObject({
      heard: expect.stringContaining('Use the other API'),
    });
    await expect(client.steer(runId, { note: 'too late' })).rejects.toMatchObject({ status: 409 }); // nothing runs: waiting for a human
    await expect(client.steer(runId, { note: '  ' })).rejects.toMatchObject({ status: 400 });
    await expect(client.steer('nope', { note: 'x' })).rejects.toMatchObject({ status: 404 });
    release?.();
    // children by parent
    const child = await client.submitRun({
      orgRoot: s.orgRoot,
      project: s.project,
      workflow: 'hello-feature',
      input: 'child',
      adapter: 'mock',
      workspace: 'inplace',
      parentRunId: runId,
    });
    expect((await client.listRuns({ parent: runId })).map((r) => r.runId)).toEqual([child.runId]);
  });
});

describe('MCP servers through the API', () => {
  const fixture = fileURLToPath(
    new URL('../../adapter-direct/test/fixtures/mcp-echo.mjs', import.meta.url),
  );
  it('GET /mcp lists the catalog servers with the roles using them and their keys; POST /mcp/:id/test connects', async () => {
    const s = setup();
    writeFileSync(
      join(s.orgRoot, 'catalog', 'echo.yaml'),
      `id: echo\ntype: mcp\ndescription: echo server\nserver:\n  transport: stdio\n  command: ${process.execPath}\n  args: ['${fixture}']\n  env_keys: [ECHO_TOKEN]\n  tools: [echo, secret]\n`,
    );
    appendFileSync(join(s.orgRoot, 'roles', 'backend.yaml'), 'mcp: [echo]\n');
    const { client } = await started(s);
    const before = await client.mcpList(s.orgRoot);
    expect(before.map((r) => r.id)).toEqual(['echo', 'higgsfield', 'playwright']); // the scaffold ships a browser
    expect(before[0]).toMatchObject({
      id: 'echo',
      description: 'echo server',
      transport: 'stdio',
      target: `${process.execPath} ${fixture}`,
      tools: ['echo', 'secret'],
      roles: ['backend'],
      keys: [{ name: 'ECHO_TOKEN', present: false }],
      server: { transport: 'stdio', command: process.execPath, env_keys: ['ECHO_TOKEN'] },
    });
    const missing = await client.mcpTest('echo', s.orgRoot);
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain('ECHO_TOKEN');
    await client.setKey('ECHO_TOKEN', 'tok');
    expect((await client.mcpList(s.orgRoot))[0]?.keys).toEqual([
      { name: 'ECHO_TOKEN', present: true },
    ]);
    const test = await client.mcpTest('echo', s.orgRoot);
    expect(test.ok).toBe(true);
    expect(test.tools?.map((t) => t.name)).toEqual(['echo', 'secret']);
    await expect(client.mcpTest('nope', s.orgRoot)).rejects.toMatchObject({ status: 404 });
    const pw = before.find((r) => r.id === 'playwright');
    expect(pw?.target).toContain('--isolated');
    expect(pw?.target).not.toContain('@latest');
  });
  it('over the network, mcp test starts servers of the daemon own org only', async () => {
    const s = setup();
    const { daemon } = await started(s, {
      env: { SHIBAOX_DAEMON_TOKEN: 'secret-1' },
      config: {
        max_concurrent_runs: 2,
        approval_timeout_minutes: 1,
        channels: { macos: { enabled: false } },
        listen: { host: '127.0.0.1', port: 0, token_env: 'SHIBAOX_DAEMON_TOKEN' },
      },
    });
    const addr = daemon.listenAddress();
    const remote = new DaemonClient({
      baseUrl: `http://127.0.0.1:${addr?.port}`,
      token: 'secret-1',
    });
    expect((await remote.mcpList(s.orgRoot)).map((r) => r.id)).toEqual([
      'higgsfield',
      'playwright',
    ]); // listing is fine
    await expect(remote.mcpTest('playwright', s.orgRoot)).rejects.toMatchObject({ status: 403 });
    const home = (await remote.defaultOrg()).root;
    const r = await remote.mcpTest('playwright', home).catch((e: { status?: number }) => e);
    expect((r as { status?: number }).status).not.toBe(403);
  });
});

describe('the app served by the daemon', () => {
  const rawGet = (socketPath: string, path: string) =>
    new Promise<{ status: number; type: string; body: string }>((resolve, reject) => {
      const req = httpRequest({ socketPath, path, method: 'GET' }, (res) => {
        let body = '';
        res.on('data', (d) => {
          body += String(d);
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            type: String(res.headers['content-type'] ?? ''),
            body,
          }),
        );
      });
      req.on('error', reject);
      req.end();
    });
  it('GET /app serves the built app on both listeners without a token; client routes get index.html; nothing outside the dist', async () => {
    const s = setup();
    const dist = mkdtempSync(join(tmpdir(), 'appdist-'));
    mkdirSync(join(dist, 'assets'));
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Shibaox</title>');
    writeFileSync(join(dist, 'assets', 'app-abc.js'), 'console.log(1)');
    writeFileSync(join(dist, 'assets', 'app.css'), 'body{}');
    writeFileSync(join(s.dir, 'secret.txt'), 'nope');
    const { daemon } = await started(s, {
      appDist: dist,
      env: { SHIBAOX_DAEMON_TOKEN: 'secret-1' },
      config: {
        max_concurrent_runs: 2,
        approval_timeout_minutes: 1,
        channels: { macos: { enabled: false } },
        listen: { host: '127.0.0.1', port: 0, token_env: 'SHIBAOX_DAEMON_TOKEN' },
      },
    });
    // the socket
    expect(await rawGet(s.home.socket, '/app/')).toMatchObject({
      status: 200,
      type: expect.stringContaining('text/html'),
    });
    expect((await rawGet(s.home.socket, '/app')).body).toContain('<title>Shibaox');
    expect(await rawGet(s.home.socket, '/app/assets/app-abc.js')).toMatchObject({
      status: 200,
      type: expect.stringContaining('javascript'),
      body: 'console.log(1)',
    });
    expect((await rawGet(s.home.socket, '/app/assets/app.css')).type).toContain('text/css');
    expect((await rawGet(s.home.socket, '/app/t/abc123')).body).toContain('<title>Shibaox'); // a client route
    expect((await rawGet(s.home.socket, '/app/assets/missing.js')).status).toBe(404); // an asset that does not exist is not index.html
    expect((await rawGet(s.home.socket, '/app/../secret.txt')).status).toBe(404);
    expect((await rawGet(s.home.socket, '/app/assets/..%2F..%2Fsecret.txt')).status).toBe(404);
    // the network listener: no token needed for the app, still needed for the API
    const port = daemon.listenAddress()?.port;
    const html = await fetch(`http://127.0.0.1:${port}/app/`);
    expect(html.status).toBe(200);
    expect(await html.text()).toContain('<title>Shibaox');
    const root = await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual' });
    expect(root.status).toBe(302);
    expect(root.headers.get('location')).toBe('/app/');
    expect((await fetch(`http://127.0.0.1:${port}/runs`)).status).toBe(401);
    // the socket's health names the listener so the CLI can open the browser at it
    const client = new DaemonClient(s.home.socket);
    expect((await client.health()).listen).toEqual({ host: '127.0.0.1', port, tls: false });
  });
  it('without the app package, /app says how to get it', async () => {
    const s = setup();
    await started(s, { appDist: null });
    const r = await rawGet(s.home.socket, '/app/');
    expect(r.status).toBe(404);
    expect(r.body).toContain('shibaox@latest');
    expect((await new DaemonClient(s.home.socket).health()).listen).toBeUndefined();
  });
});

describe('org info for the app', () => {
  it('names each workflow with its description and lists the catalog entries', async () => {
    const s = setup();
    const { client } = await started(s);
    const info = await client.orgInfo(s.orgRoot);
    expect(info.descriptions['hello-feature']).toMatch(/Analyse/);
    expect(info.catalog.find((c) => c.id === 'playwright')).toMatchObject({ type: 'mcp' });
  });
});
