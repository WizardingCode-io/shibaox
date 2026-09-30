import { DaemonUnavailableError } from '@wizardingcode/shibaox-daemon';
import { describe, expect, it } from 'vitest';
import { restartOlderDaemon } from '../src/client.js';

/** A daemon that answers `versions[i]` on the i-th health call (undefined = unavailable). */
function fakeDaemon(versions: (string | undefined)[], pids: number[] = []) {
  let i = -1;
  const calls: string[] = [];
  return {
    calls,
    client: {
      async health() {
        i++;
        const v = versions[Math.min(i, versions.length - 1)];
        if (v === undefined) throw new DaemonUnavailableError('/sock', new Error('down'));
        return {
          version: v,
          pid: pids[Math.min(i, pids.length - 1)] ?? 1,
          uptimeSeconds: 1,
          runs: { running: 0, queued: 0, waiting: 0 },
          channels: [],
        };
      },
      async shutdown() {
        calls.push('shutdown');
      },
    },
  };
}

describe('an older daemon', () => {
  it('is restarted by the CLI itself: shutdown, then spawn once it is gone, then the new version answers', async () => {
    const d = fakeDaemon(['0.0.1', undefined, undefined, '0.1.13']);
    const lines: string[] = [];
    const r = await restartOlderDaemon({
      client: d.client,
      cliVersion: '0.1.13',
      spawn: () => d.calls.push('spawn'),
      log: (l) => lines.push(l),
      pollMs: 1,
    });
    expect(r).toEqual({ restarted: true, version: '0.1.13' });
    expect(d.calls).toEqual(['shutdown', 'spawn']);
    expect(lines.join('\n')).toMatch(/older than this CLI.*restarting/);
  });
  it('a service that restarts it on its own needs no spawn: a new pid answers', async () => {
    const d = fakeDaemon(['0.0.1', '0.1.13'], [10, 11]);
    const r = await restartOlderDaemon({
      client: d.client,
      cliVersion: '0.1.13',
      spawn: () => d.calls.push('spawn'),
      log: () => {},
      pollMs: 1,
    });
    expect(r).toEqual({ restarted: true, version: '0.1.13' });
    expect(d.calls).toEqual(['shutdown']);
  });
  it('a daemon that comes back still older is reported, with the way out', async () => {
    const d = fakeDaemon(['0.0.1', '0.0.1'], [10, 11]);
    const lines: string[] = [];
    const r = await restartOlderDaemon({
      client: d.client,
      cliVersion: '0.1.13',
      spawn: () => {},
      log: (l) => lines.push(l),
      pollMs: 1,
    });
    expect(r).toEqual({ restarted: false, version: '0.0.1' });
    expect(lines.join('\n')).toMatch(/still 0\.0\.1.*daemon install/);
  });
});
