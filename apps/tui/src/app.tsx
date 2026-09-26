import { type CliRenderer, createCliRenderer } from '@opentui/core';
import { render, useKeyboard } from '@opentui/solid';
import type { JSX } from 'solid-js';
import { ClientProvider, type DaemonClientLike } from './context/client.js';

export interface AppOptions {
  version: string;
  home: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  renderer?: CliRenderer;
}

export interface AppProps extends AppOptions {
  client: DaemonClientLike;
  onExit: (code: number) => void;
  /** Stream mode: a single run, no home, no tabs (`shibaox follow`). */
  runId?: string;
}

/** The whole dashboard: providers around the shell (grows through the plan's tasks). */
export function App(props: AppProps): JSX.Element {
  useKeyboard((key) => {
    if (key.ctrl && (key.name === 'q' || key.name === 'c')) props.onExit(0);
  });
  return (
    <ClientProvider client={props.client}>
      <box flexDirection="column" padding={1}>
        <text>{`shibaox · daemon ${props.version}`}</text>
      </box>
    </ClientProvider>
  );
}

async function rendererFor(o: AppOptions): Promise<{ renderer: CliRenderer; owned: boolean }> {
  if (o.renderer) return { renderer: o.renderer, owned: false };
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    screenMode: 'alternate-screen',
    useMouse: true,
  });
  return { renderer, owned: true };
}

/** Ctrl-C outside React/Solid so a render error can never trap the terminal. */
function onCtrlC(renderer: CliRenderer, fn: () => void): () => void {
  const handler = (key: { name: string; ctrl: boolean }) => {
    if (key.ctrl && key.name === 'c') fn();
  };
  renderer.keyInput.on('keypress', handler);
  return () => renderer.keyInput.off('keypress', handler);
}

function mount(
  client: DaemonClientLike,
  o: AppOptions & { runId?: string },
  finish: (code: number) => void,
): Promise<() => void> {
  return rendererFor(o).then(async ({ renderer, owned }) => {
    let done = false;
    const end = (code: number) => {
      if (done) return;
      done = true;
      off();
      if (owned) renderer.destroy();
      finish(code);
    };
    const off = onCtrlC(renderer, () => end(0));
    await render(
      () => (
        <App
          client={client}
          version={o.version}
          home={o.home}
          cwd={o.cwd}
          env={o.env}
          runId={o.runId}
          onExit={end}
        />
      ),
      renderer,
    );
    return () => end(0);
  });
}

/** `shibaox` / `shibaox ui`: resolves with the exit code when the user quits. */
export function runDashboard(client: DaemonClientLike, o: AppOptions): Promise<number> {
  return new Promise((resolve) => {
    void mount(client, o, resolve);
  });
}

/** `shibaox run|follow` with a TTY: one run; ends with the run or when the user leaves. */
export function runStream(
  client: DaemonClientLike,
  runId: string,
  o: AppOptions & { signal?: AbortSignal },
): Promise<{ code: number; message?: string }> {
  return new Promise((resolve) => {
    void mount(client, { ...o, runId }, (code) =>
      resolve({
        code,
        message:
          code === 0
            ? `Run ${runId} keeps running. Follow it with: shibaox follow ${runId}`
            : undefined,
      }),
    ).then((stop) => o.signal?.addEventListener('abort', stop, { once: true }));
  });
}
