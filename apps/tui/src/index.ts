import { render } from 'ink';
import { createElement } from 'react';
import type { DaemonClientLike } from './client.js';
import { Poller } from './poll.js';
import { Dashboard } from './screens/Dashboard.js';
import { Stream } from './screens/Stream.js';
import { AppStore } from './store.js';

export type { DaemonClientLike } from './client.js';
export * from './components/AgentStatus.js';
export * from './components/Help.js';
export * from './components/InboxBanner.js';
export * from './components/InboxList.js';
export * from './components/NewRunForm.js';
export * from './components/Prompt.js';
export * from './components/RunDetail.js';
export * from './components/RunList.js';
export * from './components/StreamView.js';
export * from './components/TitleBar.js';
export * from './components/Toast.js';
export * from './components/ToolCallLine.js';
export * from './hooks.js';
export * from './keys.js';
export * from './poll.js';
export * from './prefs.js';
export * from './screens/Dashboard.js';
export * from './screens/Stream.js';
export * from './store.js';
export * from './stream.js';
export * from './theme.js';

/** Ink replaces its defaults with whatever keys are present, so undefined streams are left out. */
export function inkStreams(opts: RenderOptions): {
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
} {
  return {
    ...(opts.stdin ? { stdin: opts.stdin } : {}),
    ...(opts.stdout ? { stdout: opts.stdout } : {}),
  };
}

export interface RenderOptions {
  env?: NodeJS.ProcessEnv;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  cwd?: string;
  home?: string;
  /** Ink debug mode: every frame is written in full (tests with a fake stdout). */
  debug?: boolean;
}

/** The interactive dashboard; resolves with the exit code when the user quits. */
export function renderDashboard(
  client: DaemonClientLike,
  opts: RenderOptions & { version: string },
): Promise<number> {
  const store = new AppStore();
  const poller = new Poller({ client, store });
  return new Promise<number>((resolve) => {
    let instance: ReturnType<typeof render> | undefined;
    const finish = (code: number) => {
      poller.stop();
      instance?.unmount();
      resolve(code);
    };
    instance = render(
      createElement(Dashboard, {
        store,
        poller,
        version: opts.version,
        env: opts.env,
        cwd: opts.cwd,
        home: opts.home,
        onExit: finish,
      }),
      { ...inkStreams(opts), exitOnCtrlC: true, patchConsole: false, debug: opts.debug },
    );
    poller.start();
  });
}

/**
 * Follows one run (used by `run` and `follow` in a TTY). Resolves 0 when the run completes
 * or the user stops following (also when `signal` aborts), 2 when it ends any other way.
 */
export function renderStream(
  client: DaemonClientLike,
  runId: string,
  opts: RenderOptions & { since?: string; signal?: AbortSignal } = {},
): Promise<number> {
  const store = new AppStore({ selectedRunId: runId });
  const poller = new Poller({ client, store });
  return new Promise<number>((resolve) => {
    let instance: ReturnType<typeof render> | undefined;
    let settled = false;
    const finish = (status: string | undefined, quit = false) => {
      if (settled) return;
      settled = true;
      poller.stop();
      instance?.unmount();
      if (quit || status === undefined) {
        opts.stdout?.write?.(
          `\nRun ${runId} keeps running. Follow it with: shibaox follow ${runId}\n`,
        ) ?? console.log(`\nRun ${runId} keeps running. Follow it with: shibaox follow ${runId}`);
        resolve(0);
        return;
      }
      resolve(status === 'completed' ? 0 : 2);
    };
    opts.signal?.addEventListener('abort', () => finish(undefined, true), { once: true });
    instance = render(
      createElement(Stream, {
        store,
        poller,
        runId,
        env: opts.env,
        onEnd: (status) => finish(status, status === undefined),
      }),
      { ...inkStreams(opts), exitOnCtrlC: false, patchConsole: false, debug: opts.debug },
    );
    poller.start();
  });
}
