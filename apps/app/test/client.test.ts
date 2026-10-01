import { describe, expect, it } from 'vitest';
import { AppClient, AppHttpError } from '../src/api/client.js';
import { clearConnection, readConnection, saveConnection } from '../src/api/connection.js';

type Call = { url: string; init: RequestInit };
function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('AppClient', () => {
  it('sends the bearer token, parses JSON, and turns HTTP errors into AppHttpError', async () => {
    const f = fakeFetch((url) =>
      url.endsWith('/runs?thread=t1')
        ? json([{ runId: 'r1' }])
        : url.endsWith('/runs/nope')
          ? json({ error: { code: 'not_found', message: 'run nope not found' } }, 404)
          : json({ version: '0.2.1' }),
    );
    const c = new AppClient('http://127.0.0.1:7433/', 'tok', { fetch: f.fetch });
    expect(await c.health()).toEqual({ version: '0.2.1' });
    expect(f.calls[0]?.url).toBe('http://127.0.0.1:7433/health');
    expect(new Headers(f.calls[0]?.init.headers).get('authorization')).toBe('Bearer tok');
    expect(await c.listRuns({ thread: 't1' })).toEqual([{ runId: 'r1' }]);
    await expect(c.getRun('nope')).rejects.toMatchObject({ status: 404, code: 'not_found' });
    await expect(c.getRun('nope')).rejects.toBeInstanceOf(AppHttpError);
  });
  it('posts a run, a turn answer, a steer and a cancel to the daemon paths', async () => {
    const f = fakeFetch(() => json({ ok: true }));
    const c = new AppClient('http://d', undefined, { fetch: f.fetch });
    await c.submitRun({
      orgRoot: '/o',
      project: '/p',
      workflow: 'chat',
      input: 'hi',
      thread: 'root',
    } as never);
    await c.answer('approval:1', { approved: true, note: 'go' });
    await c.steer('r1', { note: 'the other way' });
    await c.cancel('r1');
    await c.resume('r1', { budgetUsd: 2 });
    expect(f.calls.map((x) => [x.init.method, x.url.replace('http://d', '')])).toEqual([
      ['POST', '/runs'],
      ['POST', '/inbox/approval%3A1'],
      ['POST', '/runs/r1/steer'],
      ['POST', '/runs/r1/cancel'],
      ['POST', '/runs/r1/resume'],
    ]);
    expect(JSON.parse(String(f.calls[1]?.init.body))).toEqual({
      via: 'api',
      approved: true,
      note: 'go',
    });
    expect(JSON.parse(String(f.calls[2]?.init.body))).toEqual({
      note: 'the other way',
      via: 'api',
    });
    expect(new Headers(f.calls[0]?.init.headers).has('authorization')).toBe(false);
  });
  it('fetches the audit document as text with the token', async () => {
    const f = fakeFetch(
      () => new Response('# Audit', { status: 200, headers: { 'content-type': 'text/markdown' } }),
    );
    const c = new AppClient('http://d', 'tok', { fetch: f.fetch });
    expect(await c.auditMarkdown('r1')).toBe('# Audit');
    expect(f.calls[0]?.url).toBe('http://d/runs/r1/audit?format=md');
    expect(new Headers(f.calls[0]?.init.headers).get('authorization')).toBe('Bearer tok');
  });
  it('streams the run events as SSE frames over fetch, with the cursor, until the end frame', async () => {
    const frames = [
      'data: {"kind":"run","seq":1,"cursor":"1:0","event":{"type":"RunStarted"}}\n\n',
      ': heartbeat\n\n',
      'data: {"kind":"runtime","seq":2,"cursor":"1:1","event":{"type":"text","text":"hi"}}\n\ndata: {"kind":"end","seq":3,"cursor":"1:1","status":"completed"}\n\n',
      'data: {"kind":"run","seq":9,"cursor":"9:0","event":{"type":"never"}}\n\n',
    ];
    const f = fakeFetch(
      () =>
        new Response(
          new ReadableStream({
            start(ctl) {
              for (const fr of frames) ctl.enqueue(new TextEncoder().encode(fr));
              ctl.close();
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    const c = new AppClient('http://d', 'tok', { fetch: f.fetch });
    const seen: string[] = [];
    for await (const e of c.stream('r1', { since: '1:0' })) seen.push(e.kind);
    expect(seen).toEqual(['run', 'runtime', 'end']);
    expect(f.calls[0]?.url).toBe('http://d/runs/r1/events?since=1%3A0');
    const bad = fakeFetch(() => json({ error: { code: 'not_found', message: 'no run' } }, 404));
    const c2 = new AppClient('http://d', 'tok', { fetch: bad.fetch });
    await expect(
      (async () => {
        for await (const _ of c2.stream('x')) {
          /* drain */
        }
      })(),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('AppClient: the sections', () => {
  it('routines, keys, org config, mcp and the project profile use the daemon paths', async () => {
    const f = fakeFetch(() => json({ ok: true }));
    const c = new AppClient('http://d', 't', { fetch: f.fetch });
    await c.routines();
    await c.runRoutine('r1');
    await c.pauseRoutine('r1');
    await c.resumeRoutine('r1');
    await c.removeRoutine('r1');
    await c.addRoutine({
      trigger: { type: 'cron', cron: '0 9 * * 1' },
      orgRoot: '/o',
      project: '/p',
      workflow: 'w',
      input: 'x',
    });
    await c.syncRoutines('/o');
    await c.keys();
    await c.setKey('OPENAI_API_KEY', 'sk');
    await c.unsetKey('OPENAI_API_KEY');
    await c.orgConfig('/o');
    await c.setOrgConfig('/o', { judge: null });
    await c.mcpList('/o');
    await c.mcpTest('pw', '/o');
    await c.projectProfile('/p', '/o');
    expect(f.calls.map((x) => `${x.init.method} ${x.url.replace('http://d', '')}`)).toEqual([
      'GET /routines',
      'POST /routines/r1/run',
      'POST /routines/r1/pause',
      'POST /routines/r1/resume',
      'DELETE /routines/r1',
      'POST /routines',
      'POST /routines/sync',
      'GET /keys',
      'PUT /keys/OPENAI_API_KEY',
      'DELETE /keys/OPENAI_API_KEY',
      'GET /orgs/config?org=%2Fo',
      'PUT /orgs/config?org=%2Fo',
      'GET /mcp?org=%2Fo',
      'POST /mcp/pw/test?org=%2Fo',
      'GET /projects/profile?path=%2Fp&org=%2Fo',
    ]);
    expect(JSON.parse(String(f.calls[8]?.init.body))).toEqual({ value: 'sk' });
  });
});

describe('AppClient: Customize', () => {
  it('skills, roles, connectors, registries and plugins use the daemon paths and bodies', async () => {
    const f = fakeFetch(() => json({ ok: true }));
    const c = new AppClient('http://d', 't', { fetch: f.fetch });
    await c.skills('/o');
    await c.addSkill('/o', { source: 'repo', repo: 'anthropics/skills', ids: ['pdf'] });
    await c.discoverSkills('anthropics/skills', 'document-skills');
    await c.discoverSkills('higgsfield-ai/skills');
    await c.removeSkill('/o', 'pdf', true);
    await c.removeSkill('/o', 'pdf', false);
    await c.roles('/o');
    await c.setRoleLinks('/o', 'assistant', { skills: ['pdf'] });
    await c.addMcp('/o', {
      id: 'ctx',
      description: 'Docs',
      server: { transport: 'http', url: 'https://mcp.context7.com/mcp' },
      roles: ['assistant'],
    });
    await c.removeMcp('/o', 'ctx');
    await c.registryConnectors();
    await c.registrySkills();
    await c.plugins();
    expect(f.calls.map((x) => `${x.init.method} ${x.url.replace('http://d', '')}`)).toEqual([
      'GET /skills?org=%2Fo',
      'POST /skills?org=%2Fo',
      'GET /skills/discover?repo=anthropics%2Fskills&path=document-skills',
      'GET /skills/discover?repo=higgsfield-ai%2Fskills',
      'DELETE /skills/pdf?org=%2Fo&detach=1',
      'DELETE /skills/pdf?org=%2Fo',
      'GET /roles?org=%2Fo',
      'PUT /roles/assistant?org=%2Fo',
      'POST /mcp?org=%2Fo',
      'DELETE /mcp/ctx?org=%2Fo',
      'GET /registry/connectors',
      'GET /registry/skills',
      'GET /plugins',
    ]);
    expect(JSON.parse(String(f.calls[1]?.init.body))).toEqual({
      source: 'repo',
      repo: 'anthropics/skills',
      ids: ['pdf'],
    });
    expect(JSON.parse(String(f.calls[7]?.init.body))).toEqual({ skills: ['pdf'] });
    expect(JSON.parse(String(f.calls[8]?.init.body))).toMatchObject({ id: 'ctx' });
  });

  it('reads one skill with its SKILL.md; an error keeps the extra fields of its body', async () => {
    const f = fakeFetch((_url, init) =>
      init.method === 'DELETE'
        ? json(
            {
              error: { code: 'in_use', message: 'skill pdf is used by assistant' },
              roles: ['assistant'],
            },
            409,
          )
        : json({ id: 'pdf', content: '# PDF' }),
    );
    const c = new AppClient('http://d', 't', { fetch: f.fetch });
    expect(await c.skill('/o', 'pdf')).toEqual({ id: 'pdf', content: '# PDF' });
    expect(f.calls[0]?.url).toBe('http://d/skills/pdf?org=%2Fo');
    await expect(c.removeSkill('/o', 'pdf', false)).rejects.toMatchObject({
      status: 409,
      code: 'in_use',
      details: { roles: ['assistant'] },
    });
  });
});

describe('the connection', () => {
  const storage = () => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    };
  };
  it('reads the token off the URL fragment once, remembers it, and strips it from the address bar', () => {
    const s = storage();
    const replaced: string[] = [];
    const conn = readConnection({
      location: {
        origin: 'http://127.0.0.1:7433',
        pathname: '/app/',
        search: '',
        hash: '#token=abc123',
      },
      storage: s,
      replaceUrl: (u) => replaced.push(u),
    });
    expect(conn).toEqual({ base: 'http://127.0.0.1:7433', token: 'abc123' });
    expect(replaced).toEqual(['/app/']);
    expect(
      readConnection({
        location: { origin: 'http://127.0.0.1:7433', pathname: '/app/', search: '', hash: '' },
        storage: s,
        replaceUrl: () => {},
      }),
    ).toEqual(conn);
  });
  it('a route in the hash survives; without a token there is no connection; save and clear', () => {
    const s = storage();
    const replaced: string[] = [];
    const conn = readConnection({
      location: { origin: 'http://h', pathname: '/app/', search: '', hash: '#/t/r1&token=zzz' },
      storage: s,
      replaceUrl: (u) => replaced.push(u),
    });
    expect(conn?.token).toBe('zzz');
    expect(replaced).toEqual(['/app/#/t/r1']);
    clearConnection(s);
    expect(
      readConnection({
        location: { origin: 'http://h', pathname: '/app/', search: '', hash: '' },
        storage: s,
        replaceUrl: () => {},
      }),
    ).toBeUndefined();
    saveConnection(s, { base: 'https://vps:7433', token: 't' });
    expect(
      readConnection({
        location: { origin: 'http://h', pathname: '/', search: '', hash: '' },
        storage: s,
        replaceUrl: () => {},
      }),
    ).toEqual({ base: 'https://vps:7433', token: 't' });
  });
  it('lists and reads the files of a run, and fetches a download as a blob with the token', async () => {
    const f = fakeFetch((url) =>
      url.includes('/files/content?path=out%2Fa.csv&download=1')
        ? new Response('name\n', { status: 200, headers: { 'content-type': 'text/csv' } })
        : url.includes('/files/content?path=out%2Fa.csv')
          ? json({
              path: 'out/a.csv',
              size: 5,
              encoding: 'utf8',
              content: 'name\n',
              truncated: false,
            })
          : json({ root: '/p', files: [{ path: 'out/a.csv', status: 'added', size: 5 }] }),
    );
    const c = new AppClient('http://d', 'tok', { fetch: f.fetch });
    expect((await c.files('r1')).files[0]?.path).toBe('out/a.csv');
    expect((await c.fileContent('r1', 'out/a.csv')).content).toBe('name\n');
    const blob = await c.fileBlob('r1', 'out/a.csv');
    expect(await blob.text()).toBe('name\n');
    for (const call of f.calls)
      expect(new Headers(call.init.headers).get('authorization')).toBe('Bearer tok');
  });

  it('writeFile PUTs the content as JSON to the run file route', async () => {
    const f = fakeFetch(() => json({ path: 'scripts/fib.js', size: 13 }));
    const c = new AppClient('http://127.0.0.1:7433/', 'tok', { fetch: f.fetch });
    await expect(c.writeFile('r1', 'scripts/fib.js', 'const a = 1;\n')).resolves.toEqual({
      path: 'scripts/fib.js',
      size: 13,
    });
    expect(f.calls[0]?.url).toBe(
      'http://127.0.0.1:7433/runs/r1/files/content?path=scripts%2Ffib.js',
    );
    expect(f.calls[0]?.init.method).toBe('PUT');
    expect(JSON.parse(String(f.calls[0]?.init.body))).toEqual({ content: 'const a = 1;\n' });
  });
});
