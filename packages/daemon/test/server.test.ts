import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryEventStore, type TaskJob } from '@shibaox/core';
import { forgetModels } from '@shibaox/providers';
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
      masked: 'sk-t…7890',
    });
    expect(JSON.stringify(keys)).not.toContain('sk-test-1234567890');
    // no restart: the models list already sees the provider as configured
    expect((await client.models()).find((m) => m.ref === 'openai/gpt-5')?.configured).toBe(true);
    await client.unsetKey('OPENAI_API_KEY');
    expect((await client.keys()).find((k) => k.name === 'OPENAI_API_KEY')?.set).toBe(false);
    expect((await client.models()).find((m) => m.ref === 'openai/gpt-5')?.configured).toBe(false);
    await expect(client.setKey('bad name', 'x')).rejects.toMatchObject({ status: 400 });
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
