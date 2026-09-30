import { describe, expect, it } from 'vitest';
import { type LaunchDeps, planLaunch, single } from '../src/launch.js';

type TestDeps = LaunchDeps & {
  lines: string[];
  clock: number;
  started: number;
  ports: number[];
  closed: number;
};

function deps(over: Partial<LaunchDeps> & { alive?: boolean[] } = {}): TestDeps {
  const alive = over.alive ?? [true];
  let i = 0;
  const d: TestDeps = {
    lines: [] as string[],
    started: 0,
    ports: [] as number[],
    closed: 0,
    remote: () => undefined,
    probe: async () => alive[Math.min(i++, alive.length - 1)] as boolean,
    startDaemon: async () => {
      d.started++;
      return { ok: true };
    },
    startBridge: async (port: number) => {
      d.ports.push(port);
      return {
        url: `http://127.0.0.1:${port || 50000}/app/#token=t`,
        port: port || 50000,
        close: async () => {
          d.closed++;
        },
      };
    },
    sleep: async () => {},
    now: () => (d.clock += 100),
    clock: 0,
    log: (line: string) => d.lines.push(line),
    candidatePorts: [7434, 7435],
    waitMs: 1000,
    stepMs: 100,
    ...over,
  };
  return d;
}

describe('planLaunch', () => {
  it('a remote daemon with a token: its own app address, nothing started here', async () => {
    const d = deps({ remote: () => ({ baseUrl: 'https://vps.example', token: 'abc' }) });
    const plan = await planLaunch(d);
    expect(plan).toEqual({ kind: 'remote', url: 'https://vps.example/app/#token=abc' });
    expect(d.started).toBe(0);
    expect(d.ports).toEqual([]);
  });

  it('a remote daemon without a token is explained, not replaced by the local one', async () => {
    const plan = await planLaunch(deps({ remote: () => ({ baseUrl: 'https://vps.example' }) }));
    expect(plan.kind).toBe('offline');
    expect(plan.kind === 'offline' && plan.reason).toMatch(/shibaox remote set/);
  });

  it('a broken remote.json is explained', async () => {
    const plan = await planLaunch(
      deps({ remote: () => ({ error: 'remote.json is not valid JSON' }) }),
    );
    expect(plan).toMatchObject({ kind: 'offline', reason: 'remote.json is not valid JSON' });
  });

  it('a live daemon: the bridge on the first stable port', async () => {
    const d = deps({ alive: [true] });
    const plan = await planLaunch(d);
    expect(plan).toMatchObject({ kind: 'bridge', url: 'http://127.0.0.1:7434/app/#token=t' });
    expect(d.started).toBe(0);
    expect(d.ports).toEqual([7434]);
  });

  it('a stopped daemon is started and waited for, then the bridge comes up', async () => {
    const d = deps({ alive: [false, false, true] });
    const plan = await planLaunch(d);
    expect(plan.kind).toBe('bridge');
    expect(d.started).toBe(1);
  });

  it('a daemon that never answers: offline, with the bridge closed again', async () => {
    const d = deps({ alive: [false], waitMs: 300, stepMs: 100 });
    const plan = await planLaunch(d);
    expect(plan.kind).toBe('offline');
    expect(plan.kind === 'offline' && plan.reason).toMatch(/daemon/);
    expect(d.started).toBe(1);
    expect(d.ports).toEqual([]);
  });

  it('a taken port is skipped; with none free the bridge takes any port', async () => {
    const busy = new Set([7434]);
    const d = deps();
    const inner = d.startBridge;
    d.startBridge = async (port) => {
      if (busy.has(port))
        throw Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
      return inner(port);
    };
    expect((await planLaunch(d)).url).toContain(':7435/');
    busy.add(7435);
    const plan = await planLaunch(d);
    expect(plan.url).toContain(':50000/');
    expect(d.ports).toEqual([7435, 0]);
  });

  it('a daemon start that fails at once is explained at once, without the wait', async () => {
    const d = deps({
      alive: [false],
      startDaemon: async () => ({ ok: false, reason: 'shibaox is not in the PATH of /bin/zsh' }),
    });
    let slept = 0;
    d.sleep = async () => {
      slept++;
    };
    const plan = await planLaunch(d);
    expect(plan).toMatchObject({
      kind: 'offline',
      reason: 'shibaox is not in the PATH of /bin/zsh',
    });
    expect(slept).toBe(0);
  });

  it('the wait for a started daemon is bounded by the clock, not by a count of steps', async () => {
    let probes = 0;
    const d = deps({ waitMs: 15_000, stepMs: 500 });
    d.probe = async () => {
      probes++;
      return false;
    };
    d.now = () => (d.clock += 5000); // each probe takes 5 s (a slow socket)
    const plan = await planLaunch(d);
    expect(plan.kind).toBe('offline');
    expect(probes).toBeLessThanOrEqual(5);
  });

  it('a bridge error other than a taken port is explained, not thrown', async () => {
    const d = deps({
      startBridge: async () => {
        throw Object.assign(new Error('listen EACCES 127.0.0.1:7434'), { code: 'EACCES' });
      },
    });
    const plan = await planLaunch(d);
    expect(plan).toMatchObject({ kind: 'offline', reason: expect.stringContaining('EACCES') });
  });
});

describe('single', () => {
  it('runs one launch at a time: callers during a launch share it, later callers get a new one', async () => {
    let runs = 0;
    let release: () => void = () => {};
    const fn = single(async () => {
      runs++;
      await new Promise<void>((r) => {
        release = r;
      });
      return runs;
    });
    const a = fn();
    const b = fn();
    expect(b).toBe(a);
    release();
    expect(await a).toBe(1);
    const c = fn();
    expect(c).not.toBe(a);
    release();
    expect(await c).toBe(2);
  });
});
