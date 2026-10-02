import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryEventStore } from '@wizardingcode/shibaox-core';
import { loadOrg } from '@wizardingcode/shibaox-schemas';
import { afterEach, describe, expect, it } from 'vitest';
import { DaemonClient } from '../src/client.js';
import { Daemon } from '../src/daemon.js';
import { homePaths } from '../src/home.js';
import { commandEnv } from '../src/runtime.js';
import { scaffoldOrg } from '../src/templates.js';

const tmp: string[] = [];
const daemons: Daemon[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop({ force: true }).catch(() => undefined);
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('Higgsfield in the scaffold', () => {
  it('a new org has the Higgsfield server, its skill, and an assistant that uses both', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hf-'));
    tmp.push(dir);
    scaffoldOrg(dir);
    const org = loadOrg(join(dir, 'org'));
    const hf = org.catalog.higgsfield;
    expect(hf?.server).toMatchObject({
      transport: 'http',
      url: 'https://mcp.higgsfield.ai/mcp',
      bearer_command: ['higgsfield', 'auth', 'token'],
    });
    expect(hf?.server?.tools).toContain('generate_image_batch');
    expect(hf?.server?.tools).not.toContain('use_higgsfield');
    const assistant = org.roles.assistant;
    expect(assistant?.mcp).toContain('higgsfield');
    expect(assistant?.skills).toContain('higgsfield');
    expect(assistant?.tools).toContain('higgsfield');
    const skill = readFileSync(join(dir, 'org', 'skills', 'higgsfield', 'SKILL.md'), 'utf8');
    expect(skill).toMatch(/download_file/);
    expect(skill).toMatch(/never say you cannot/i);
    expect(readFileSync(join(dir, 'org', 'prompts', 'assistant.md'), 'utf8')).toMatch(/Higgsfield/);
  });

  it('both paths: the higgsfield skill covers the account and the API, higgsfield-app builds apps', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hf-'));
    tmp.push(dir);
    scaffoldOrg(dir);
    const org = loadOrg(join(dir, 'org'));
    expect(org.roles.assistant?.skills).toEqual(['higgsfield', 'higgsfield-app']);
    const skill = readFileSync(join(dir, 'org', 'skills', 'higgsfield', 'SKILL.md'), 'utf8');
    expect(skill).toContain('higgsfield_api_generate');
    expect(skill).toContain('higgsfield_api_upload');
    expect(skill).toContain('https://docs.higgsfield.ai/docs/llms.txt');
    expect(skill).toContain('higgsfield-ai/soul/standard');
    expect(skill).toMatch(/never both/i);
    expect(skill).toMatch(/higgsfield_upload/); // the account path is still there
    const app = readFileSync(join(dir, 'org', 'skills', 'higgsfield-app', 'SKILL.md'), 'utf8');
    expect(app).toMatch(/^---\nname: higgsfield-app\n/);
    expect(app).toContain('Paste the API key copied from open.higgsfield.ai. Paste it as-is.');
    // only the variables the official text names, and the generic wording
    expect(app).not.toContain('HF_API_KEY');
    expect(app).toMatch(/`HF_CREDENTIALS` for the TypeScript SDK/);
    expect(app).toMatch(/`HF_KEY`\s+for the Python/);
    expect(app).toContain('server-only environment variable');
    // tool names a runtime may not have come with their generic fallback
    expect(skill).toContain("`web_fetch` (or your runtime's fetch/download tool)");
    expect(skill).toContain('lists them under `files`');
    expect(app).toContain('Connect API key');
    expect(app).toContain('higgsfield-ai/app-templates/studio');
    expect(app).toContain('pnpm dlx shadcn@latest init -t next');
    expect(app).toMatch(/cannot read .*key/i);
    const prompt = readFileSync(join(dir, 'org', 'prompts', 'assistant.md'), 'utf8');
    expect(prompt).toContain('higgsfield-app skill');
    expect(prompt).toMatch(/API tools|account's MCP/);
  });

  it('the connector registry note names both modes', async () => {
    const { connectorRegistry } = await import('../src/registry/connectors.js');
    const hf = connectorRegistry().find((c) => c.id === 'higgsfield');
    expect(hf?.note).toMatch(/account/i);
    expect(hf?.note).toMatch(/API key/);
  });
});

describe('the command environment PATH', () => {
  it('adds the user bins the service PATH lacks, once, after what is there', () => {
    const env = commandEnv({ PATH: '/usr/bin:/bin', HOME: '/Users/me' });
    expect(env.PATH).toBe('/usr/bin:/bin:/Users/me/.local/bin:/opt/homebrew/bin:/usr/local/bin');
    const again = commandEnv({ PATH: env.PATH ?? '', HOME: '/Users/me' });
    expect(again.PATH).toBe(env.PATH);
    // an env without a PATH keeps the process's own (the system bins stay reachable)
    expect(commandEnv({}).PATH).toContain('/usr/bin');
  });
});

describe('GET /integrations/higgsfield', () => {
  async function daemon(probe: ConstructorParameters<typeof Daemon>[0]['higgsfield']) {
    const dir = mkdtempSync(join(tmpdir(), 'hf-srv-'));
    tmp.push(dir);
    scaffoldOrg(dir);
    const home = homePaths({ SHIBAOX_HOME: join(dir, 'home') });
    const d = new Daemon({
      discovery: false,
      home,
      store: new MemoryEventStore(),
      channels: [],
      env: {},
      log: () => {},
      version: '9.9.9',
      vault: join(dir, 'vault'),
      higgsfield: probe,
    });
    daemons.push(d);
    await d.start();
    return new DaemonClient(home.socket);
  }
  it('says the CLI is missing, with the install command and the account link', async () => {
    const c = await daemon({
      exec: async () => ({ exitCode: 127, stdout: '', stderr: 'not found' }),
      mcp: async () => 'unreachable',
      login: async () => ({ started: true }),
    });
    const v = await c.higgsfield();
    expect(v).toMatchObject({ cli: { installed: false }, loggedIn: false, mcp: 'unreachable' });
    expect(v.installCommand).toContain('install.sh');
    expect(v.signupUrl).toBe('https://higgsfield.ai?fpr=andre-4fae29');
    await expect(c.higgsfieldLogin()).rejects.toMatchObject({ status: 409 });
  });
  it('with the CLI logged in: version, account, credits, and the MCP reachable', async () => {
    const calls: string[][] = [];
    const c = await daemon({
      exec: async (argv) => {
        calls.push(argv);
        if (argv[1] === 'version')
          return { exitCode: 0, stdout: 'higgsfield 1.1.26 (abc) built 2026-09-18\n', stderr: '' };
        if (argv[1] === 'account')
          return {
            exitCode: 0,
            stdout: '{"credits": 3.5, "email": "a@b.c", "subscription_plan_type": "plus"}\n',
            stderr: '',
          };
        if (argv[1] === 'auth') return { exitCode: 0, stdout: 'oat_x\n', stderr: '' };
        return { exitCode: 1, stdout: '', stderr: 'unknown' };
      },
      mcp: async (token) => (token === 'oat_x' ? 'ok' : 'unauthorized'),
      login: async () => {
        calls.push(['higgsfield', 'auth', 'login']);
        return { started: true };
      },
    });
    const v = await c.higgsfield();
    expect(v).toMatchObject({
      cli: { installed: true, version: '1.1.26' },
      loggedIn: true,
      account: { email: 'a@b.c', plan: 'plus', credits: 3.5 },
      mcp: 'ok',
    });
    const r = await c.higgsfieldLogin();
    expect(r).toMatchObject({ started: true });
    expect(calls.some((a) => a[1] === 'auth' && a[2] === 'login')).toBe(true);
  });

  it('a not-logged-in answer is not cached: the next read probes again', async () => {
    let calls = 0;
    const c = await daemon({
      exec: async (argv) => {
        if (argv[1] === 'version')
          return { exitCode: 0, stdout: 'higgsfield 1.1.26\n', stderr: '' };
        calls++;
        return { exitCode: 1, stdout: '', stderr: 'Not authenticated' };
      },
      mcp: async () => 'unreachable',
      login: async () => ({ started: true }),
    });
    await c.higgsfield();
    await c.higgsfield();
    expect(calls).toBeGreaterThanOrEqual(2);
  });
  it('without an API key the API is never probed; mode auto falls back to the account', async () => {
    let probes = 0;
    const c = await daemon({
      exec: async (argv) =>
        argv[1] === 'version'
          ? { exitCode: 0, stdout: 'higgsfield 1.1.26\n', stderr: '' }
          : argv[1] === 'account'
            ? { exitCode: 0, stdout: '{"email":"a@b.c"}', stderr: '' }
            : { exitCode: 0, stdout: 'tok\n', stderr: '' },
      mcp: async () => 'ok',
      login: async () => ({ started: true }),
      apiCheck: async () => {
        probes++;
        return { valid: true, status: 404 };
      },
    });
    const v = await c.higgsfield();
    expect(v.api).toEqual({ keySet: false });
    expect(v).toMatchObject({ mode: 'auto', effective: 'account' });
    expect(probes).toBe(0);
  });

  it('a saved key is probed once a minute per key; a new key probes again; 401 is valid:false', async () => {
    const keys: string[] = [];
    const c = await daemon({
      exec: async () => ({ exitCode: 127, stdout: '', stderr: '' }),
      mcp: async () => 'unreachable',
      login: async () => ({ started: true }),
      apiCheck: async (key) => {
        keys.push(key);
        return key === 'id:good' ? { valid: true, status: 404 } : { valid: false, status: 401 };
      },
    });
    await c.setKey('HIGGSFIELD_API_KEY', 'id:good');
    const v = await c.higgsfield();
    expect(v.api).toMatchObject({ keySet: true, valid: true, status: 404 });
    expect(typeof v.api.checkedAt).toBe('string');
    expect(v).toMatchObject({ mode: 'auto', effective: 'api' });
    await c.higgsfield();
    expect(keys).toEqual(['id:good']);
    await c.setKey('HIGGSFIELD_API_KEY', 'id:bad');
    expect((await c.higgsfield()).api).toMatchObject({ keySet: true, valid: false, status: 401 });
    expect(keys).toEqual(['id:good', 'id:bad']);
    expect(JSON.stringify(await c.higgsfield())).not.toContain('id:bad');
    await c.unsetKey('HIGGSFIELD_API_KEY');
    expect((await c.higgsfield()).api).toEqual({ keySet: false });
  });

  it('PUT /integrations/higgsfield {mode} writes daemon.yaml keeping comments; a bad mode is 400', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hf-mode-'));
    tmp.push(dir);
    scaffoldOrg(dir);
    const home = homePaths({ SHIBAOX_HOME: join(dir, 'home') });
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(home.root, { recursive: true });
    writeFileSync(home.config, '# mine\nmax_concurrent_runs: 2 # two\n');
    const d = new Daemon({
      discovery: false,
      home,
      store: new MemoryEventStore(),
      channels: [],
      env: {},
      log: () => {},
      version: '9.9.9',
      vault: join(dir, 'vault'),
      higgsfield: {
        exec: async () => ({ exitCode: 127, stdout: '', stderr: '' }),
        mcp: async () => 'unreachable',
        login: async () => ({ started: true }),
      },
    });
    daemons.push(d);
    await d.start();
    const c = new DaemonClient(home.socket);
    const v = await c.setHiggsfieldMode('api');
    expect(v).toMatchObject({ mode: 'api', effective: 'none' });
    const text = readFileSync(home.config, 'utf8');
    expect(text).toContain('# mine');
    expect(text).toContain('# two');
    expect(text).toMatch(/mode: api/);
    expect((await c.higgsfield()).mode).toBe('api');
    expect(d.config.partners.higgsfield.mode).toBe('api');
    await expect(c.setHiggsfieldMode('x' as never)).rejects.toMatchObject({ status: 400 });
    expect(readFileSync(home.config, 'utf8')).toBe(text);
    // edited by hand into a broken file while the daemon runs: refused, untouched
    const broken = '# mine\nmax_concurrent_runs: 2\npartners: {higgsfield: \n';
    writeFileSync(home.config, broken);
    await expect(c.setHiggsfieldMode('account')).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/daemon\.yaml has a syntax error at line \d+: fix it first/),
    });
    expect(readFileSync(home.config, 'utf8')).toBe(broken);
  });

  it('PUT /integrations/higgsfield is refused to another machine and through a proxy', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hf-mode-far-'));
    tmp.push(dir);
    scaffoldOrg(dir);
    const home = homePaths({ SHIBAOX_HOME: join(dir, 'home') });
    let local = true;
    const d = new Daemon({
      discovery: false,
      home,
      store: new MemoryEventStore(),
      channels: [],
      env: { SHIBAOX_DAEMON_TOKEN: 'secret-1' },
      log: () => {},
      version: '9.9.9',
      vault: join(dir, 'vault'),
      localPeer: () => local,
      config: {
        max_concurrent_runs: 2,
        approval_timeout_minutes: 1,
        channels: { macos: { enabled: false } },
        projects: [],
        listen: { host: '127.0.0.1', port: 0, token_env: 'SHIBAOX_DAEMON_TOKEN' },
      } as never,
      higgsfield: {
        exec: async () => ({ exitCode: 127, stdout: '', stderr: '' }),
        mcp: async () => 'unreachable',
        login: async () => ({ started: true }),
      },
    });
    daemons.push(d);
    await d.start();
    const base = `http://127.0.0.1:${d.listenAddress()?.port}`;
    const put = (headers: Record<string, string> = {}) =>
      fetch(`${base}/integrations/higgsfield`, {
        method: 'PUT',
        headers: {
          authorization: 'Bearer secret-1',
          'content-type': 'application/json',
          ...headers,
        },
        body: JSON.stringify({ mode: 'api' }),
      });
    expect((await put({ 'x-forwarded-for': '203.0.113.9' })).status).toBe(403);
    local = false;
    expect((await put()).status).toBe(403);
    expect(existsSync(home.config)).toBe(false);
    local = true;
    expect((await put()).status).toBe(200);
    expect(readFileSync(home.config, 'utf8')).toMatch(/mode: api/);
  });

  it('the login endpoint answers a loopback client of the network listener, and returns what the CLI printed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hf-listen-'));
    tmp.push(dir);
    scaffoldOrg(dir);
    const home = homePaths({ SHIBAOX_HOME: join(dir, 'home') });
    const d = new Daemon({
      discovery: false,
      home,
      store: new MemoryEventStore(),
      channels: [],
      env: { SHIBAOX_DAEMON_TOKEN: 'secret-1' },
      log: () => {},
      version: '9.9.9',
      vault: join(dir, 'vault'),
      config: {
        max_concurrent_runs: 2,
        approval_timeout_minutes: 1,
        channels: { macos: { enabled: false } },
        projects: [],
        listen: { host: '127.0.0.1', port: 0, token_env: 'SHIBAOX_DAEMON_TOKEN' },
      } as never,
      higgsfield: {
        exec: async (argv) =>
          argv[1] === 'version'
            ? { exitCode: 0, stdout: 'higgsfield 1.1.26\n', stderr: '' }
            : { exitCode: 1, stdout: '', stderr: 'Not authenticated' },
        mcp: async () => 'unreachable',
        login: async () => ({ started: true, url: 'https://higgsfield.ai/device?code=ABCD' }),
      },
    });
    daemons.push(d);
    await d.start();
    const addr = d.listenAddress();
    const remote = new DaemonClient({
      baseUrl: `http://127.0.0.1:${addr?.port}`,
      token: 'secret-1',
    });
    await expect(remote.higgsfieldLogin()).resolves.toMatchObject({
      started: true,
      url: 'https://higgsfield.ai/device?code=ABCD',
    });
  });
});
