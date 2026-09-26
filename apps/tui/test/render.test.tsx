import { EventEmitter } from 'node:events';
import type { Envelope } from '@shibaox/daemon';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderDashboard, renderStream } from '../src/index.js';
import { FakeDaemonClient } from '../src/testing/fake-client.js';

/** Minimal stdin/stdout stand-ins for Ink (ink-testing-library keeps its own private). */
class FakeStdout extends EventEmitter {
  columns = 100;
  rows = 30;
  frames: string[] = [];
  isTTY = true;
  write = (s: string) => {
    this.frames.push(s);
    return true;
  };
  /** Everything written so far, without ANSI control sequences. */
  text = () =>
    this.frames
      .join('')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal escapes
      .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
}
class FakeStdin extends EventEmitter {
  isTTY = true;
  private data: string | null = null;
  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
  read = () => {
    const d = this.data;
    this.data = null;
    return d;
  };
  /** Ink reads on `readable`, the way ink-testing-library's Stdin does. */
  push(s: string) {
    this.data = s;
    this.emit('readable');
  }
}

const run = (runId: string, status = 'running') =>
  ({
    runId,
    workflow: 'hello-feature',
    status,
    createdAt: '2026-09-26T10:00:00.000Z',
    updatedAt: '2026-09-26T10:00:00.000Z',
    spentUsd: 0.1,
  }) as never;
const state = (runId: string, status = 'running') =>
  ({
    runId,
    workflow: 'hello-feature',
    status,
    nodes: { analyse: { status: 'completed', attempts: 1, approvals: {} } },
    spentUsd: 0.1,
    pendingHumans: [],
    pendingApprovals: [],
  }) as never;
const frame = (
  runId: string,
  kind: 'run' | 'runtime' | 'end',
  payload: Record<string, unknown>,
  seq = 1,
): Envelope =>
  ({
    kind,
    seq,
    cursor: `${seq}:${seq}`,
    ...(kind === 'end'
      ? payload
      : {
          event:
            kind === 'run'
              ? { runId, at: 'x', seq, ...payload }
              : { runId, nodeId: 'impl', seq, at: 'x', event: payload },
        }),
  }) as unknown as Envelope;

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

let io: { stdin: FakeStdin; stdout: FakeStdout };
afterEach(() => {
  vi.useRealTimers();
});

describe('renderStream', () => {
  it('follows a run to completion and resolves 0', async () => {
    const client = new FakeDaemonClient();
    client.runs = [run('r1')];
    client.states.set('r1', state('r1'));
    io = { stdin: new FakeStdin(), stdout: new FakeStdout() };
    const done = renderStream(client, 'r1', {
      stdin: io.stdin as never,
      stdout: io.stdout as never,
      env: { SHIBAOX_NO_MOTION: '1' },
      debug: true,
    });
    await settle();
    client.pushFrame('r1', frame('r1', 'run', { type: 'NodeStarted', nodeId: 'impl' }));
    client.pushFrame(
      'r1',
      frame('r1', 'runtime', { type: 'tool_use', id: 't1', name: 'Read', input: {} }, 2),
    );
    client.pushFrame(
      'r1',
      frame(
        'r1',
        'runtime',
        { type: 'tool_result', id: 't1', name: 'Read', output: 'ok', durationMs: 7 },
        3,
      ),
    );
    await settle();
    expect(io.stdout.text()).toContain('> Read');
    client.states.set('r1', state('r1', 'completed'));
    client.pushFrame('r1', frame('r1', 'end', { status: 'completed' }, 9));
    expect(await done).toBe(0);
    expect(io.stdout.text()).toContain('Done');
  });

  it('resolves 2 when the run fails, and asks about a pending human item', async () => {
    const client = new FakeDaemonClient();
    client.runs = [run('r2', 'waiting_human')];
    client.states.set('r2', state('r2', 'waiting_human'));
    client.inboxItems = [
      {
        id: 'human:r2:ship',
        kind: 'human',
        runId: 'r2',
        nodeId: 'ship',
        at: 'x',
        prompt: 'Approve the push?',
        detail: { action: 'ship' },
      },
    ];
    io = { stdin: new FakeStdin(), stdout: new FakeStdout() };
    const done = renderStream(client, 'r2', {
      stdin: io.stdin as never,
      stdout: io.stdout as never,
      env: { SHIBAOX_NO_MOTION: '1' },
      debug: true,
    });
    await settle(60);
    expect(io.stdout.text()).toContain('Approve the push?');
    io.stdin.push('a');
    await settle();
    expect(client.calls.find((c) => c.method === 'answer')?.args[0]).toBe('human:r2:ship');
    client.states.set('r2', state('r2', 'failed'));
    client.pushFrame('r2', frame('r2', 'end', { status: 'failed' }, 9));
    expect(await done).toBe(2);
  });

  it('an aborted signal resolves 0 and says the run keeps running', async () => {
    const client = new FakeDaemonClient();
    client.runs = [run('r3')];
    client.states.set('r3', state('r3'));
    io = { stdin: new FakeStdin(), stdout: new FakeStdout() };
    const ac = new AbortController();
    const done = renderStream(client, 'r3', {
      stdin: io.stdin as never,
      stdout: io.stdout as never,
      signal: ac.signal,
      env: {},
      debug: true,
    });
    await settle();
    ac.abort();
    expect(await done).toBe(0);
    expect(io.stdout.text()).toContain('keeps running');
  });
});

describe('Ctrl-C and history (final review)', () => {
  it('Ctrl-C in the dashboard resolves 0 and closes the poller', async () => {
    const client = new FakeDaemonClient();
    client.runs = [run('r1')];
    client.states.set('r1', state('r1'));
    io = { stdin: new FakeStdin(), stdout: new FakeStdout() };
    const done = renderDashboard(client, {
      version: '0.0.1',
      stdin: io.stdin as never,
      stdout: io.stdout as never,
      env: { SHIBAOX_NO_MOTION: '1' },
      debug: true,
    });
    await settle(60);
    io.stdin.push('\x03');
    expect(await done).toBe(0);
    await settle();
    expect(client.openStreams()).toEqual([]);
  });

  it('Ctrl-C while following resolves 0 and says the run keeps running', async () => {
    const client = new FakeDaemonClient();
    client.runs = [run('r3')];
    client.states.set('r3', state('r3'));
    io = { stdin: new FakeStdin(), stdout: new FakeStdout() };
    const done = renderStream(client, 'r3', {
      stdin: io.stdin as never,
      stdout: io.stdout as never,
      env: {},
      debug: true,
    });
    await settle();
    io.stdin.push('\x03');
    expect(await done).toBe(0);
    expect(io.stdout.text()).toContain('keeps running');
  });

  it('following a finished run replays the whole history before ending', async () => {
    const client = new FakeDaemonClient();
    client.runs = [run('r4', 'completed')];
    client.states.set('r4', state('r4', 'completed'));
    client.history.set('r4', [
      frame('r4', 'run', { type: 'NodeStarted', nodeId: 'analyse' }, 1),
      frame('r4', 'run', { type: 'NodeStarted', nodeId: 'implement' }, 2),
      frame('r4', 'run', { type: 'NodeStarted', nodeId: 'qa' }, 3),
      frame('r4', 'end', { status: 'completed' }, 4),
    ]);
    io = { stdin: new FakeStdin(), stdout: new FakeStdout() };
    expect(
      await renderStream(client, 'r4', {
        stdin: io.stdin as never,
        stdout: io.stdout as never,
        env: {},
        debug: true,
      }),
    ).toBe(0);
    const text = io.stdout.text();
    for (const n of ['── analyse ──', '── implement ──', '── qa ──']) expect(text).toContain(n);
  });

  it('never erases the terminal scrollback', async () => {
    const client = new FakeDaemonClient();
    client.runs = [run('r5', 'completed')];
    client.states.set('r5', state('r5', 'completed'));
    client.history.set('r5', [frame('r5', 'end', { status: 'completed' }, 1)]);
    io = { stdin: new FakeStdin(), stdout: new FakeStdout() };
    await renderStream(client, 'r5', {
      stdin: io.stdin as never,
      stdout: io.stdout as never,
      env: {},
    });
    expect(io.stdout.frames.join('')).not.toContain('\x1b[3J');
    const io2 = { stdin: new FakeStdin(), stdout: new FakeStdout() };
    const done = renderDashboard(client, {
      version: '0.0.1',
      stdin: io2.stdin as never,
      stdout: io2.stdout as never,
      env: {},
    });
    await settle(60);
    io2.stdin.push('q');
    await done;
    // the dashboard draws on the alternate screen and restores the main one on exit
    const out = io2.stdout.frames.join('');
    expect(out).toContain('\x1b[?1049h');
    expect(out).toContain('\x1b[?1049l');
  });
});

describe('inkStreams', () => {
  it('leaves undefined streams out so Ink keeps process.stdin/stdout', async () => {
    const { inkStreams } = await import('../src/index.js');
    expect(inkStreams({})).toEqual({});
    expect(Object.keys(inkStreams({ stdin: undefined, stdout: undefined }))).toEqual([]);
    const stdout = new FakeStdout() as never;
    expect(inkStreams({ stdout })).toEqual({ stdout });
  });
});

describe('renderDashboard', () => {
  it('resolves when q is pressed and closes the poller', async () => {
    const client = new FakeDaemonClient();
    client.runs = [run('r1')];
    client.states.set('r1', state('r1'));
    io = { stdin: new FakeStdin(), stdout: new FakeStdout() };
    const done = renderDashboard(client, {
      version: '0.0.1',
      stdin: io.stdin as never,
      stdout: io.stdout as never,
      env: { SHIBAOX_NO_MOTION: '1' },
      debug: true,
    });
    await settle(60);
    expect(io.stdout.text()).toContain('hello-feature');
    io.stdin.push('q');
    expect(await done).toBe(0);
    await settle();
    expect(client.openStreams()).toEqual([]);
  });
});
