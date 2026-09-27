import { type MouseEvent, TextAttributes } from '@opentui/core';
import { useTerminalDimensions } from '@opentui/solid';
import { createEffect, createMemo, createSignal, type JSX, onCleanup, Show } from 'solid-js';
import { Confirm } from '../../component/dialogs/confirm.js';
import { DiffDialog } from '../../component/dialogs/diff.js';
import { type KeyHint, KeyHints } from '../../component/footer.js';
import { Sidebar } from '../../component/sidebar.js';
import { useCommands } from '../../context/commands.js';
import { useData } from '../../context/data.js';
import { useKeys } from '../../context/keys.js';
import { usePrefs } from '../../context/prefs.js';
import { duration, shortId } from '../../model/format.js';
import { statusOf } from '../../model/status.js';
import { createAnimatable, spring } from '../../motion/animation.js';
import { useMotion } from '../../motion/config.js';
import { ShimmerText } from '../../motion/shimmer-text.js';
import { useTheme } from '../../theme/context.js';
import { useDialog } from '../../ui/dialog.js';
import { clampSidebarWidth, SIDEBAR_WIDTH, sidebarAuto } from '../../ui/layout.js';
import { createPaneResize } from '../../ui/pane-resize.js';
import { useToast } from '../../ui/toast.js';
import { ApprovalBar, pendingFor } from './approval-bar.js';
import { ContextLine } from './context-line.js';
import { ContinuePrompt } from './continue.js';
import { Timeline, type TimelineApi } from './timeline.js';

export const SESSION_HINTS: KeyHint[] = [
  { key: 'enter', label: 'expand' },
  { key: 'd', label: 'diff' },
  { key: 'tab', label: 'sidebar' },
  { key: 'ctrl+n', label: 'home' },
  { key: '?', label: 'help' },
];
export const STREAM_HINTS: KeyHint[] = [
  { key: 'enter', label: 'expand' },
  { key: 'd', label: 'diff' },
  { key: 'q', label: 'quit' },
];

const DOTS = ['·', '·', '·', '·', '·', '·'];
const DOT_MS = 120;

/** The dotted progress of a working run (the reference's `······` under the prompt). */
function Dots(props: { active: boolean }): JSX.Element {
  const theme = useTheme();
  const motion = useMotion();
  const [head, setHead] = createSignal(0);
  createEffect(() => {
    if (!props.active || !motion()) return;
    const t = setInterval(() => setHead((h) => (h + 1) % (DOTS.length + 2)), DOT_MS);
    onCleanup(() => clearInterval(t));
  });
  const glyphs = () =>
    DOTS.map((_, i) => (props.active && motion() && Math.abs(i - head()) <= 1 ? '▪' : '·')).join(
      '',
    );
  return (
    <text fg={props.active ? theme.text.action.primary.selected : theme.text.muted} wrapMode="none">
      {glyphs()}
    </text>
  );
}

/** One run as a conversation: request, cards, the status box (or the approval bar), and the sidebar. */
export function SessionFrame(props: { runId: string; single?: boolean }): JSX.Element {
  const data = useData();
  const theme = useTheme();
  const dialog = useDialog();
  const toast = useToast();
  const prefs = usePrefs();
  const motion = useMotion();
  const dimensions = useTerminalDimensions();
  const [now, setNow] = createSignal(Date.now());
  const tick = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(tick));

  // the tab is a thread: the status, the pending items and the prompt belong to its latest run
  const latest = () => {
    const runs = data.threadOf(props.runId);
    return runs[runs.length - 1] ?? props.runId;
  };
  const summary = () => data.state.runs.find((r) => r.runId === latest());
  const state = () => data.state.states[latest()];
  const status = () =>
    data.state.ended[latest()] ?? state()?.status ?? summary()?.status ?? 'queued';
  const look = () => statusOf({ status: status() });
  const working = () => status() === 'running';
  const _spent = () => state()?.spentUsd ?? summary()?.spentUsd ?? 0;
  const elapsed = () => {
    const created = summary()?.createdAt;
    const updated = summary()?.updatedAt;
    if (!created) return undefined;
    const from = Date.parse(created);
    const terminal = status() === 'completed' || status() === 'failed' || status() === 'cancelled';
    const to = terminal && updated ? Date.parse(updated) : now();
    return Number.isFinite(from) && Number.isFinite(to)
      ? duration(Math.max(0, to - from))
      : undefined;
  };
  const activeNode = () => {
    const nodes = state()?.nodes ?? {};
    return Object.entries(nodes).find(
      ([, n]) => n.status === 'running' || n.status === 'waiting',
    )?.[0];
  };
  const color = () => {
    const f = look().feedback;
    return f === 'muted' ? theme.text.muted : theme.text.feedback[f];
  };
  const pending = createMemo(() => pendingFor(data.state.inbox, latest()));
  const finished = () => ['completed', 'failed', 'cancelled'].includes(status());
  let timeline: TimelineApi | undefined;

  // sidebar: automatic on wide terminals, toggled with ctrl+b, resizable with the mouse
  const area = () => dimensions().width;
  const [openedByKey, setOpenedByKey] = createSignal<boolean | undefined>(undefined);
  const sidebarVisible = createMemo(() => {
    if (props.single) return false;
    if (openedByKey() !== undefined) return openedByKey() as boolean;
    return prefs.data.sidebar !== 'hide' && sidebarAuto(dimensions().width, 0);
  });
  const resize = createPaneResize({
    value: () => prefs.data.sidebarWidth ?? SIDEBAR_WIDTH,
    defaultValue: () => SIDEBAR_WIDTH,
    clamp: (w) => clampSidebarWidth(w, area()),
    fromMouse: (e: MouseEvent) => dimensions().width - e.x - 1,
    contains: (e: MouseEvent, w) =>
      e.x >= dimensions().width - w - 1 && e.x <= dimensions().width - w,
    onCommit: (w) => prefs.update({ sidebarWidth: w }),
  });
  const anim = createAnimatable(
    { w: sidebarVisible() ? resize.size() : 0 },
    { transition: spring({ visualDuration: 0.25 }), enabled: motion },
  );
  createEffect(() => anim.animate({ w: sidebarVisible() ? resize.size() : 0 }));
  const sidebarWidth = () => Math.round(anim.value().w);
  const [focus, setFocus] = createSignal<'conversation' | 'sidebar'>('conversation');
  createEffect(() => {
    if (!sidebarVisible()) setFocus('conversation');
  });

  const toggleSidebar = () => {
    const next = !sidebarVisible();
    setOpenedByKey(next);
    prefs.update({ sidebar: next ? 'auto' : 'hide' });
  };
  const cancel = () =>
    dialog.open(() => (
      <Confirm
        message={`Cancel run ${shortId(latest())}?`}
        onYes={() => {
          dialog.close();
          void data.actions.cancel(latest());
        }}
        onNo={() => dialog.close()}
      />
    ));
  const resume = () => {
    if (status() === 'paused_budget') void data.actions.resume(latest());
    else toast.show({ message: 'Nothing to resume', variant: 'info' });
  };
  const diff = () => dialog.open(() => <DiffDialog runId={latest()} />);
  const unregister = useCommands().register([
    { id: 'diff', label: 'Diff of the run', keys: 'd', run: diff },
    {
      id: 'sidebar',
      label: 'Toggle sidebar',
      keys: 'ctrl+b',
      run: toggleSidebar,
      when: () => !props.single,
    },
    { id: 'cancel', label: 'Cancel run', keys: 'c', run: cancel },
    {
      id: 'resume',
      label: 'Resume run',
      keys: 'r',
      run: resume,
      when: () => status() === 'paused_budget',
    },
  ]);
  onCleanup(unregister);
  useKeys('global', (key) => {
    if (props.single || !(key.ctrl && key.name === 'b')) return false;
    toggleSidebar();
    return true;
  });
  useKeys('pane', (key) => {
    if (key.ctrl || key.meta) return false;
    if (key.name === 'tab' && sidebarVisible()) {
      setFocus((f) => (f === 'sidebar' ? 'conversation' : 'sidebar'));
      return true;
    }
    if (focus() !== 'conversation') return false;
    if (key.name === 'c') {
      cancel();
      return true;
    }
    if (key.name === 'r') {
      resume();
      return true;
    }
    if (key.name === 'd' && pending().length === 0) {
      diff();
      return true;
    }
    return false;
  });
  const hints = () => {
    const base = props.single ? STREAM_HINTS : SESSION_HINTS;
    if (status() === 'paused_budget') return [{ key: 'r', label: 'resume' }, ...base];
    return base;
  };

  return (
    <box
      flexDirection="row"
      width="100%"
      height="100%"
      onMouseDrag={resize.onMouseDrag}
      onMouseDragEnd={resize.onMouseDragEnd}
      onMouseUp={resize.onMouseUp}
    >
      <box flexDirection="column" flexGrow={1} height="100%">
        <Timeline
          runId={props.runId}
          focused={focus() === 'conversation'}
          api={(a) => {
            timeline = a;
          }}
        />
        <box flexDirection="row" width="100%" flexShrink={0} paddingLeft={2} paddingRight={2}>
          <box
            width={1}
            flexShrink={0}
            backgroundColor={
              pending().length > 0
                ? theme.text.feedback.warning
                : theme.text.action.primary.selected
            }
          />
          <box
            flexGrow={1}
            flexDirection="column"
            paddingLeft={2}
            paddingRight={2}
            paddingTop={1}
            paddingBottom={1}
            backgroundColor={theme.background.raised.base}
          >
            <Show
              when={pending().length > 0}
              fallback={
                <Show
                  when={!finished() || props.single}
                  fallback={
                    <ContinuePrompt
                      onSubmit={(t) => void data.continueRun(props.runId, t)}
                      onScroll={(n) => timeline?.scrollBy(n)}
                      footer={<ContextLine runId={props.runId} elapsed={elapsed()} />}
                    />
                  }
                >
                  <box height={1} flexShrink={0} flexDirection="row">
                    <Show
                      when={working()}
                      fallback={
                        <text
                          fg={color()}
                          attributes={TextAttributes.BOLD}
                          wrapMode="none"
                        >{`${look().symbol} ${look().word}`}</text>
                      }
                    >
                      <ShimmerText
                        fg={color()}
                        shimmer={theme.text.base}
                        attributes={TextAttributes.BOLD}
                        wrapMode="none"
                      >
                        {`${look().symbol} ${look().word}`}
                      </ShimmerText>
                    </Show>
                    <text fg={theme.text.muted} wrapMode="none">
                      {activeNode() ? ` · ${activeNode()}` : ''}
                    </text>
                  </box>
                  <box height={1} flexShrink={0} flexDirection="row">
                    <ContextLine runId={props.runId} elapsed={elapsed()} />
                  </box>
                </Show>
              }
            >
              <ApprovalBar runId={latest()} />
            </Show>
          </box>
        </box>
        <box
          height={1}
          flexShrink={0}
          flexDirection="row"
          paddingLeft={2}
          paddingRight={2}
          width="100%"
        >
          <Dots active={working()} />
          <text fg={theme.text.muted} wrapMode="none">
            {'  '}
          </text>
          <Show when={working() || status() === 'waiting_human' || status() === 'waiting_approval'}>
            <KeyHints hints={[{ key: 'c', label: 'cancel' }]} />
          </Show>
          <box flexGrow={1} flexShrink={0} width={2} />
          <KeyHints hints={hints()} />
        </box>
      </box>
      <Show when={sidebarWidth() > 0}>
        <box
          width={1}
          flexShrink={0}
          height="100%"
          backgroundColor={
            resize.hovered() || resize.resizing()
              ? theme.background.raised.high
              : theme.background.base
          }
          onMouseOver={resize.onMouseOver}
          onMouseOut={resize.onMouseOut}
          onMouseDown={resize.onMouseDown}
        />
        <Sidebar
          runId={latest()}
          rootId={props.runId}
          width={sidebarWidth()}
          focused={focus() === 'sidebar'}
          onFocusBack={() => setFocus('conversation')}
        />
      </Show>
    </box>
  );
}
