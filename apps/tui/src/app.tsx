import { type CliRenderer, createCliRenderer } from '@opentui/core';
import { render } from '@opentui/solid';
import { type JSX, Match, Switch } from 'solid-js';
import { ClientProvider, type DaemonClientLike } from './context/client.js';
import { ConfigProvider } from './context/config.js';
import { DataProvider } from './context/data.js';
import { ExitProvider } from './context/exit.js';
import { KeysProvider } from './context/keys.js';
import { loadPrefs, PrefsProvider } from './context/prefs.js';
import { type Route, RouteProvider, useRoute } from './context/route.js';
import { MotionProvider, motionEnabled } from './motion/config.js';
import { Home } from './routes/home.js';
import { ThemeProvider } from './theme/context.js';
import { DialogProvider } from './ui/dialog.js';
import { Toast, ToastProvider, useToast } from './ui/toast.js';

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

const sessionId = (r: Route) => (r.type === 'session' ? r.runId : '');

function Shell(props: { single?: string }): JSX.Element {
  const route = useRoute();
  return (
    <box width="100%" height="100%" flexDirection="column">
      <Switch>
        <Match when={route.data().type === 'home' && !props.single}>
          <Home />
        </Match>
        <Match when={route.data().type === 'session'}>
          <text>{`session ${sessionId(route.data())}`}</text>
        </Match>
      </Switch>
      <Toast />
    </box>
  );
}

function WithData(props: AppProps): JSX.Element {
  const toast = useToast();
  return (
    <DataProvider client={props.client} single={props.runId} toast={(t) => toast.show(t)}>
      <RouteProvider
        initial={props.runId ? { type: 'session', runId: props.runId } : { type: 'home' }}
      >
        <Shell single={props.runId} />
      </RouteProvider>
    </DataProvider>
  );
}

/** The whole dashboard: providers around the shell. */
export function App(props: AppProps): JSX.Element {
  const env = props.env ?? process.env;
  const cwd = props.cwd ?? process.cwd();
  return (
    <ClientProvider client={props.client}>
      <ConfigProvider config={{ version: props.version, home: props.home, cwd }}>
        <PrefsProvider home={props.home}>
          <MotionProvider enabled={motionEnabled(env, loadPrefs(props.home))}>
            <ThemeProvider>
              <KeysProvider onExit={props.onExit}>
                <ExitProvider onExit={props.onExit}>
                  <ToastProvider>
                    <DialogProvider>
                      <WithData {...props} />
                    </DialogProvider>
                  </ToastProvider>
                </ExitProvider>
              </KeysProvider>
            </ThemeProvider>
          </MotionProvider>
        </PrefsProvider>
      </ConfigProvider>
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

/** Ctrl-C outside Solid so a render error can never trap the terminal. */
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
    // the in-app handler decides first (a prompt may consume ctrl+c); this one is the safety net
    const off = onCtrlC(renderer, () => setTimeout(() => (done ? undefined : undefined), 0));
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
