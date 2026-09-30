import type { RunState } from '@wizardingcode/shibaox-core';
import { DaemonHttpError } from '@wizardingcode/shibaox-daemon';
import { describe, expect, it } from 'vitest';
import { followRun } from '../src/commands/follow.js';
import { followAny } from '../src/commands/run.js';
import { makeOut } from '../src/output.js';

const state = (status: string): RunState =>
  ({
    runId: 'r1',
    workflow: 'wf',
    status,
    nodes: { a: { status: 'completed', attempts: 1, approvals: {} } },
    spentUsd: 0.5,
    pendingHumans: [],
    pendingApprovals: [],
  }) as never;

describe('followAny (terminal path)', () => {
  it('prints the final state after the Bun stream ends', async () => {
    const lines: string[] = [];
    const out = makeOut(false, (l) => lines.push(l));
    const client = { getRun: async () => state('failed') } as never;
    const spawned: string[][] = [];
    const code = await followAny(client, 'r1', {}, out, {
      tty: true,
      bunAvailable: async () => true,
      spawnTui: async (args) => {
        spawned.push(args);
        return 2;
      },
    });
    expect(code).toBe(2);
    expect(spawned[0]?.slice(0, 2)).toEqual(['stream', 'r1']);
    expect(lines.join('\n')).toContain('status=failed');
    expect(lines.join('\n')).toContain('spent=$0.5000');
  });

  it('refuses an unknown run before spawning anything', async () => {
    const out = makeOut(false, () => {});
    const client = {
      getRun: async () => {
        throw new DaemonHttpError(404, 'not_found', 'run nope not found');
      },
    } as never;
    let spawned = 0;
    await expect(
      followAny(client, 'nope', {}, out, {
        tty: true,
        bunAvailable: async () => true,
        spawnTui: async () => {
          spawned++;
          return 0;
        },
      }),
    ).rejects.toThrow('run nope not found');
    expect(spawned).toBe(0);
  });
});

describe('tuiSpawnOptions', () => {
  it('spawns from the tui directory with a trimmed env', async () => {
    const { tuiSpawnOptions, TUI_ROOT, TUI_ARGS } = await import('../src/commands/ui.js');
    const o = tuiSpawnOptions({
      PATH: '/bin',
      HOME: '/h',
      ANTHROPIC_API_KEY: 'sk',
      SHIBAOX_HOME: '/x',
      LC_ALL: 'C',
      TERM: 'xterm',
    });
    expect(o.cwd).toBe(TUI_ROOT);
    expect(TUI_ROOT.endsWith('/apps/tui/')).toBe(true);
    expect(TUI_ARGS).toEqual(['--preload', '@opentui/solid/preload']);
    expect(o.env).toEqual({
      PATH: '/bin',
      HOME: '/h',
      SHIBAOX_HOME: '/x',
      LC_ALL: 'C',
      TERM: 'xterm',
    });
  });
});

describe('followRun over a connection that drops', () => {
  it('reopens the stream after the last cursor when it ends without an end frame', async () => {
    const lines: string[] = [];
    const out = makeOut(true, (l) => lines.push(l));
    const calls: (string | undefined)[] = [];
    const client = {
      async *events(_id: string, o: { since?: string }) {
        calls.push(o.since);
        if (calls.length === 1) {
          yield {
            kind: 'run',
            seq: 1,
            cursor: '1:0',
            event: { runId: 'r1', seq: 1, type: 'RunStarted' },
          };
          return; // the proxy closed the connection: no end frame
        }
        yield { kind: 'end', seq: 0, cursor: '2:0', status: 'completed' };
      },
      getRun: async () => state(calls.length === 1 ? 'running' : 'completed'),
      inbox: async () => [],
    } as never;
    const code = await followRun(client, 'r1', { reconnectMs: 1 }, out);
    expect(code).toBe(0);
    expect(calls).toEqual([undefined, '1:0']);
  });
});
