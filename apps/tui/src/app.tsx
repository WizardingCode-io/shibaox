import { type CliRenderer, createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import type { DaemonClientLike } from './client.js';
import { Poller } from './poll.js';
import { AppStore } from './store.js';
import { Dashboard } from './ui/Dashboard.js';
import { Stream } from './ui/Stream.js';

export interface AppOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  home: string;
  /** An existing renderer (tests); by default a real one on the alternate screen. */
  renderer?: CliRenderer;
}

async function rendererFor(opts: AppOptions): Promise<{ renderer: CliRenderer; owned: boolean }> {
  if (opts.renderer) return { renderer: opts.renderer, owned: false };
  const renderer = await createCliRenderer({ exitOnCtrlC: false, screenMode: 'alternate-screen' });
  return { renderer, owned: true };
}

/** The dashboard; resolves with the exit code when the user quits. */
export async function runDashboard(
  client: DaemonClientLike,
  opts: AppOptions & { version: string },
): Promise<number> {
  const store = new AppStore();
  const poller = new Poller({ client, store });
  const { renderer, owned } = await rendererFor(opts);
  const root = createRoot(renderer);
  return new Promise<number>((resolve) => {
    let done = false;
    const finish = (code: number) => {
      if (done) return;
      done = true;
      poller.stop();
      root.unmount();
      if (owned) renderer.destroy();
      resolve(code);
    };
    root.render(
      <Dashboard
        store={store}
        poller={poller}
        version={opts.version}
        env={opts.env}
        cwd={opts.cwd ?? process.cwd()}
        home={opts.home}
        onExit={finish}
      />,
    );
    poller.start();
  });
}

/** Follows one run; 0 when it completes or the user stops following, 2 otherwise. */
export async function runStream(
  client: DaemonClientLike,
  runId: string,
  opts: AppOptions & { signal?: AbortSignal },
): Promise<{ code: number; message?: string }> {
  const store = new AppStore({ selectedRunId: runId });
  const poller = new Poller({ client, store });
  const { renderer, owned } = await rendererFor(opts);
  const root = createRoot(renderer);
  return new Promise((resolve) => {
    let done = false;
    const finish = (status: string | undefined) => {
      if (done) return;
      done = true;
      poller.stop();
      root.unmount();
      if (owned) renderer.destroy();
      if (status === undefined)
        resolve({
          code: 0,
          message: `Run ${runId} keeps running. Follow it with: shibaox follow ${runId}`,
        });
      else resolve({ code: status === 'completed' ? 0 : 2 });
    };
    opts.signal?.addEventListener('abort', () => finish(undefined), { once: true });
    root.render(
      <Stream store={store} poller={poller} runId={runId} env={opts.env} onEnd={finish} />,
    );
    poller.start();
  });
}
