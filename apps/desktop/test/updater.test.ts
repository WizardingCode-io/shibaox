import { describe, expect, it } from 'vitest';
import {
  startUpdater,
  type UpdaterOptions,
  type UpdateSource,
  type UpdateUi,
} from '../src/updater.js';

interface Fake {
  source: UpdateSource;
  ui: UpdateUi;
  opts: UpdaterOptions;
  checks: number;
  installs: number;
  asked: string[];
  said: string[];
  lines: string[];
  timers: { ms: number; fn: () => void; repeat: boolean }[];
  downloaded?: (version: string) => void;
  failed?: (reason: string) => void;
  fire(i: number): void;
}

function fake(
  over: {
    packaged?: boolean;
    found?: () => Promise<string | undefined>;
    answer?: 'restart' | 'later';
  } = {},
): Fake {
  const f: Fake = {
    checks: 0,
    installs: 0,
    asked: [],
    said: [],
    lines: [],
    timers: [],
    fire: (i) => f.timers[i]?.fn(),
    source: {
      check: async () => {
        f.checks++;
        return over.found ? over.found() : undefined;
      },
      onDownloaded: (cb) => {
        f.downloaded = cb;
      },
      onError: (cb) => {
        f.failed = cb;
      },
      install: () => {
        f.installs++;
      },
    },
    ui: {
      ask: async (version) => {
        f.asked.push(version);
        return over.answer ?? 'later';
      },
      say: async (message) => {
        f.said.push(message);
      },
    },
    opts: {
      packaged: over.packaged ?? true,
      version: '0.2.5',
      startDelayMs: 10_000,
      intervalMs: 4 * 3600_000,
      setTimeout: (fn, ms) => {
        f.timers.push({ ms, fn, repeat: false });
        return f.timers.length - 1;
      },
      setInterval: (fn, ms) => {
        f.timers.push({ ms, fn, repeat: true });
        return f.timers.length - 1;
      },
      clear: () => {},
      log: (line) => f.lines.push(line),
    },
  };
  return f;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('the desktop updater', () => {
  it('a packaged app checks once after the start delay and then on the interval', async () => {
    const f = fake();
    startUpdater(f.source, f.ui, f.opts);
    expect(f.timers.map((t) => [t.ms, t.repeat])).toEqual([
      [10_000, false],
      [4 * 3600_000, true],
    ]);
    expect(f.checks).toBe(0);
    f.fire(0);
    f.fire(1);
    await tick();
    expect(f.checks).toBe(2);
    expect(f.asked).toEqual([]); // nothing found: nobody is bothered
  });

  it('an unpackaged app (pnpm start) never checks, and says so when asked by hand', async () => {
    const f = fake({ packaged: false });
    const u = startUpdater(f.source, f.ui, f.opts);
    expect(f.timers).toEqual([]);
    await u.checkNow();
    expect(f.checks).toBe(0);
    expect(f.said[0]).toMatch(/packaged|release/i);
  });

  it('a downloaded update asks once; Restart installs, Later waits for the next version or a manual check', async () => {
    const f = fake({ found: async () => '0.2.6' });
    const u = startUpdater(f.source, f.ui, f.opts);
    f.fire(0);
    await tick();
    f.downloaded?.('0.2.6');
    await tick();
    expect(f.asked).toEqual(['0.2.6']);
    expect(f.installs).toBe(0);
    // the same version downloaded again (a later check) does not ask again
    f.downloaded?.('0.2.6');
    await tick();
    expect(f.asked).toEqual(['0.2.6']);
    // a manual check with that version ready asks again; Restart installs
    f.ui.ask = async (v) => {
      f.asked.push(v);
      return 'restart';
    };
    await u.checkNow();
    expect(f.asked).toEqual(['0.2.6', '0.2.6']);
    expect(f.installs).toBe(1);
  });

  it('a manual check reports up to date, a found version, or the error; a scheduled check only logs the error', async () => {
    const upToDate = fake();
    await startUpdater(upToDate.source, upToDate.ui, upToDate.opts).checkNow();
    expect(upToDate.said).toEqual(['Shibaox 0.2.5 is the latest version.']);

    const found = fake({ found: async () => '0.2.6' });
    await startUpdater(found.source, found.ui, found.opts).checkNow();
    expect(found.said[0]).toMatch(/0\.2\.6.*download/i);

    const broken = fake({
      found: async () => {
        // electron-updater's errors carry the response headers on the lines after the first
        throw new Error('ENOTFOUND github.com\nHeaders: {\n  "server": "github.com"\n}');
      },
    });
    const u = startUpdater(broken.source, broken.ui, broken.opts);
    broken.fire(0);
    await tick();
    expect(broken.said).toEqual([]);
    expect(broken.lines.join('\n')).toContain('ENOTFOUND github.com');
    await u.checkNow();
    expect(broken.said[0]).toMatch(/could not check.*connection/i);
    expect(broken.said[0]).not.toContain('Headers');
  });

  it('an update that fails after its download is forgotten: no Restart offer, the manual check says why', async () => {
    const f = fake({ found: async () => '0.2.6' });
    const u = startUpdater(f.source, f.ui, f.opts);
    f.downloaded?.('0.2.6');
    await tick();
    expect(f.asked).toEqual(['0.2.6']);
    f.failed?.('Code signature at URL … did not pass validation');
    f.ui.ask = async (v) => {
      f.asked.push(v);
      return 'restart';
    };
    await u.checkNow();
    expect(f.installs).toBe(0);
    expect(f.asked).toEqual(['0.2.6']);
    expect(f.said[0]).toMatch(/could not .*0\.2\.6.*did not pass validation/i);
    expect(f.lines.join('\n')).toContain('did not pass validation');
  });

  it('a manual check with a version waiting checks first: a newer one wins, the same one is offered again', async () => {
    let latest = '0.2.6';
    const f = fake({ found: async () => latest });
    const u = startUpdater(f.source, f.ui, f.opts);
    f.downloaded?.('0.2.6');
    await tick();
    expect(f.asked).toEqual(['0.2.6']);
    latest = '0.2.7';
    await u.checkNow();
    expect(f.checks).toBe(1);
    expect(f.said[0]).toMatch(/0\.2\.7.*download/i);
    expect(f.asked).toEqual(['0.2.6']);
    latest = '0.2.6';
    await u.checkNow();
    expect(f.asked).toEqual(['0.2.6', '0.2.6']);
  });

  it('dialogs never stack: the ready prompt waits for an open message', async () => {
    const f = fake({ found: async () => '0.2.6' });
    let release: (() => void) | undefined;
    const order: string[] = [];
    f.ui.say = async (m) => {
      order.push(`say:${m.slice(0, 13)}`);
      await new Promise<void>((r) => {
        release = r;
      });
    };
    f.ui.ask = async (v) => {
      order.push(`ask:${v}`);
      return 'later';
    };
    const u = startUpdater(f.source, f.ui, f.opts);
    const manual = u.checkNow();
    await tick();
    f.downloaded?.('0.2.6');
    await tick();
    expect(order).toEqual(['say:Shibaox 0.2.6']);
    release?.();
    await manual;
    await tick();
    expect(order).toEqual(['say:Shibaox 0.2.6', 'ask:0.2.6']);
  });

  it('the manual check puts the usual failures in plain words', async () => {
    const cases: [string, RegExp][] = [
      [
        'Cannot find latest-mac.yml in the latest release artifacts (https://github.com/x/y/releases/download/v0.2.3/latest-mac.yml): HttpError: 404',
        /latest release .*no update/i,
      ],
      ['net::ERR_INTERNET_DISCONNECTED', /offline|connection/i],
      ['getaddrinfo ENOTFOUND github.com', /offline|connection/i],
    ];
    for (const [message, words] of cases) {
      const f = fake({
        found: async () => {
          throw new Error(message);
        },
      });
      await startUpdater(f.source, f.ui, f.opts).checkNow();
      expect(f.said[0]).toMatch(words);
    }
  });

  it('stop() clears the timers', () => {
    const f = fake();
    const cleared: unknown[] = [];
    f.opts.clear = (id) => cleared.push(id);
    startUpdater(f.source, f.ui, f.opts).stop();
    expect(cleared).toEqual([0, 1]);
  });
});
