import { type CliRenderer, createCliRenderer } from '@opentui/core';
import { render, useTerminalDimensions } from '@opentui/solid';
import { createEffect, type JSX, Match, Show, Switch } from 'solid-js';
import { HelpDialog } from './component/dialogs/help.js';
import { PaletteDialog } from './component/dialogs/palette.js';
import { RunsDialog } from './component/dialogs/runs.js';
import { Reconnecting } from './component/reconnecting.js';
import { Tabs } from './component/tabs.js';
import { TooSmall } from './component/too-small.js';
import { ClientProvider, type DaemonClientLike } from './context/client.js';
import { CommandsProvider, useCommands } from './context/commands.js';
import { ConfigProvider } from './context/config.js';
import { type Data, DataProvider, useData } from './context/data.js';
import { ExitProvider, useExit } from './context/exit.js';
import { KeysProvider, useKeys } from './context/keys.js';
import { loadPrefs, PrefsProvider } from './context/prefs.js';
import { RouteProvider } from './context/route.js';
import { MotionProvider, motionEnabled } from './motion/config.js';
import { Home } from './routes/home.js';
import { SessionFrame } from './routes/session/index.js';
import { ThemeProvider } from './theme/context.js';
import { DialogProvider, useDialog } from './ui/dialog.js';
import { railVertical, tooSmall } from './ui/layout.js';
import { Toast, ToastProvider, useToast } from './ui/toast.js';

export interface AppOptions {
  version: string;
  home: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  renderer?: CliRenderer;
  log?: (line: string) => void;
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
  /** Where stream failures and malformed frames are noted (`~/.shibaox/tui.log`). */
  log?: (line: string) => void;
}

/** Tabs rail, the active tab's screen (home or a run), overlays and toasts. */
function Shell(props: { single?: string }): JSX.Element {
  const data = useData();
  const dialog = useDialog();
  const commands = useCommands();
  const exit = useExit();
  const dimensions = useTerminalDimensions();
  const vertical = () => railVertical(dimensions().width);
  const active = () => props.single ?? data.state.active;
  const help = () => dialog.open(() => <HelpDialog />);
  const shell = [
    {
      id: 'home',
      label: 'New run',
      keys: 'ctrl+n',
      run: () => data.activate(undefined),
      when: () => !props.single,
    },
    {
      id: 'runs',
      label: 'Open a run',
      keys: 'ctrl+o',
      run: () => dialog.open(() => <RunsDialog />),
      when: () => !props.single,
    },
    {
      id: 'next',
      label: 'Next tab',
      keys: 'ctrl+]',
      run: () => data.nextTab(1),
      when: () => !props.single,
    },
    {
      id: 'prev',
      label: 'Previous tab',
      keys: 'ctrl+p',
      run: () => data.nextTab(-1),
      when: () => !props.single,
    },
    {
      id: 'close',
      label: 'Close tab',
      keys: 'ctrl+w',
      run: () => data.state.active && data.closeRun(data.state.active),
      when: () => !!data.state.active && !props.single,
    },
    { id: 'help', label: 'Help', keys: '?', run: help },
    { id: 'quit', label: 'Quit', keys: 'ctrl+q', run: () => exit(0) },
  ];
  commands.register(shell);
  useKeys('global', (key) => {
    if (key.name === '?' && !key.ctrl) {
      help();
      return true;
    }
    if (!key.ctrl) return false;
    if (key.name === 'k') {
      dialog.open(() => <PaletteDialog />);
      return true;
    }
    if (props.single) return false;
    const cmd = shell.find((c) => c.keys === `ctrl+${key.name}`);
    if (!cmd) return false;
    cmd.run();
    return true;
  });
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
    <DataProvider
      client={props.client}
      single={props.runId}
      toast={(t) => toast.show(t)}
      log={props.log}
    >
      <RouteProvider
        initial={props.runId ? { type: 'session', runId: props.runId } : { type: 'home' }}
      >
        <Hooks onMount={props.onMount} runId={props.runId} onEnded={props.onEnded} />
        <CommandsProvider>
          <DialogProvider>
            <Shell single={props.runId} />
          </DialogProvider>
        </CommandsProvider>
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
                    <WithData {...props} />
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
          log={o.log}
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
