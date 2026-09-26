import { type CliRenderer, createCliRenderer } from '@opentui/core';
import { render, useTerminalDimensions } from '@opentui/solid';
import { createEffect, type JSX, Match, Show, Switch } from 'solid-js';
import { Reconnecting } from './component/reconnecting.js';
import { Tabs } from './component/tabs.js';
import { TooSmall } from './component/too-small.js';
import { ClientProvider, type DaemonClientLike } from './context/client.js';
import { ConfigProvider } from './context/config.js';
import { type Data, DataProvider, useData } from './context/data.js';
import { ExitProvider } from './context/exit.js';
import { KeysProvider, useKeys } from './context/keys.js';
import { loadPrefs, PrefsProvider } from './context/prefs.js';
import { RouteProvider } from './context/route.js';
import { MotionProvider, motionEnabled } from './motion/config.js';
import { Home } from './routes/home.js';
import { SessionFrame } from './routes/session/index.js';
import { ThemeProvider } from './theme/context.js';
import { DialogProvider } from './ui/dialog.js';
import { railVertical, tooSmall } from './ui/layout.js';
import { Toast, ToastProvider, useToast } from './ui/toast.js';

export interface AppOptions {
  version: string;
  home: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  renderer?: CliRenderer;
}

/** What tests and the stream entry get from a mounted app. */
export interface AppHooks {
  data: Data;
}

export interface AppProps extends AppOptions {
  client: DaemonClientLike;
  onExit: (code: number) => void;
  /** Stream mode: a single run, no home, no tabs (`shibaox follow`). */
  runId?: string;
  /** Stream mode: the run reached a terminal status. */
  onEnded?: (status: string) => void;
  onMount?: (hooks: AppHooks) => void;
}

/** Tabs rail, the active tab's screen (home or a run), overlays and toasts. */
function Shell(props: { single?: string }): JSX.Element {
  const data = useData();
  const dimensions = useTerminalDimensions();
  const vertical = () => railVertical(dimensions().width);
  useKeys('global', (key) => {
    if (props.single || !key.ctrl) return false;
    switch (key.name) {
      case 'n':
        data.activate(undefined);
        return true;
      case ']':
        data.nextTab(1);
        return true;
      case 'p': // ctrl+[ would be Escape in every terminal
        data.nextTab(-1);
        return true;
      case 'w':
        if (data.state.active) data.closeRun(data.state.active);
        return true;
      default:
        return false;
    }
  });
  const active = () => props.single ?? data.state.active;
  return (
    <box width="100%" height="100%" flexDirection="column">
      <Show when={!tooSmall(dimensions().width, dimensions().height)} fallback={<TooSmall />}>
        <box width="100%" height="100%" flexDirection={vertical() ? 'row' : 'column'}>
          <Show when={!props.single}>
            <Tabs vertical={vertical()} />
          </Show>
          <box flexGrow={1} flexDirection="column" height="100%">
            <Switch>
              <Match when={!active()}>
                <Home />
              </Match>
              <Match when={active()}>
                {(id) => <SessionFrame runId={id()} single={!!props.single} />}
              </Match>
            </Switch>
          </box>
        </box>
      </Show>
      <Reconnecting since={() => data.state.unreachableSince} />
      <Toast />
    </box>
  );
}

function Hooks(props: {
  onMount?: (h: AppHooks) => void;
  runId?: string;
  onEnded?: (status: string) => void;
}): JSX.Element {
  const data = useData();
  props.onMount?.({ data });
  createEffect(() => {
    const status = props.runId ? data.state.ended[props.runId] : undefined;
    if (status) props.onEnded?.(status);
  });
  return null;
}

function WithData(props: AppProps): JSX.Element {
  const toast = useToast();
  return (
    <DataProvider client={props.client} single={props.runId} toast={(t) => toast.show(t)}>
      <RouteProvider
        initial={props.runId ? { type: 'session', runId: props.runId } : { type: 'home' }}
      >
        <Hooks onMount={props.onMount} runId={props.runId} onEnded={props.onEnded} />
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

/** Ctrl-C outside Solid so a crash before the first frame can never trap the terminal. */
function onCtrlC(renderer: CliRenderer, fn: () => void): () => void {
  const handler = (key: { name: string; ctrl: boolean }) => {
    if (key.ctrl && key.name === 'c') fn();
  };
  renderer.keyInput.on('keypress', handler);
  return () => renderer.keyInput.off('keypress', handler);
}

type Outcome = { code: number; ended?: string };

function mount(
  client: DaemonClientLike,
  o: AppOptions & { runId?: string },
  finish: (outcome: Outcome) => void,
): Promise<() => void> {
  return rendererFor(o).then(async ({ renderer, owned }) => {
    let done = false;
    let rendered = false;
    const end = (outcome: Outcome) => {
      if (done) return;
      done = true;
      off();
      if (owned) renderer.destroy();
      finish(outcome);
    };
    // the in-app handler decides ctrl+c (a prompt may consume it); this listener only saves
    // the terminal when the app never rendered
    const off = onCtrlC(renderer, () => {
      if (!rendered) end({ code: 0 });
    });
    await render(
      () => (
        <App
          client={client}
          version={o.version}
          home={o.home}
          cwd={o.cwd}
          env={o.env}
          runId={o.runId}
          onExit={(code) => end({ code })}
          onEnded={(status) => end({ code: status === 'completed' ? 0 : 2, ended: status })}
          onMount={() => {
            rendered = true;
          }}
        />
      ),
      renderer,
    );
    return () => end({ code: 0 });
  });
}

/** `shibaox` / `shibaox ui`: resolves with the exit code when the user quits. */
export function runDashboard(client: DaemonClientLike, o: AppOptions): Promise<number> {
  return new Promise((resolve) => {
    void mount(client, o, (r) => resolve(r.code));
  });
}

/**
 * `shibaox run|follow` with a TTY: one run; ends with the run (0 done, 2 otherwise) or when the
 * user leaves (then the message says the run keeps running).
 */
export function runStream(
  client: DaemonClientLike,
  runId: string,
  o: AppOptions & { signal?: AbortSignal },
): Promise<{ code: number; message?: string }> {
  return new Promise((resolve) => {
    void mount(client, { ...o, runId }, (r) =>
      resolve(
        r.ended
          ? { code: r.code }
          : {
              code: r.code,
              message:
                r.code === 0
                  ? `Run ${runId} keeps running. Follow it with: shibaox follow ${runId}`
                  : undefined,
            },
      ),
    ).then((stop) => o.signal?.addEventListener('abort', stop, { once: true }));
  });
}
