import type { RunState } from '@wizardingcode/shibaox-core';
import { DaemonHttpError } from '@wizardingcode/shibaox-daemon';
import { describe, expect, it } from 'vitest';
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
