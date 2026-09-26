import { type MouseEvent, TextAttributes } from '@opentui/core';
import { useTerminalDimensions } from '@opentui/solid';
import { createEffect, createMemo, createSignal, type JSX, onCleanup, Show } from 'solid-js';
import { Confirm } from '../../component/dialogs/confirm.js';
import { Footer } from '../../component/footer.js';
import { Sidebar } from '../../component/sidebar.js';
import { useCommands } from '../../context/commands.js';
import { useData } from '../../context/data.js';
import { useKeys } from '../../context/keys.js';
import { usePrefs } from '../../context/prefs.js';
import { duration, money, shortId } from '../../model/format.js';
import { statusOf } from '../../model/status.js';
import { createAnimatable, spring } from '../../motion/animation.js';
import { useMotion } from '../../motion/config.js';
import { ShimmerText } from '../../motion/shimmer-text.js';
import { useTheme } from '../../theme/context.js';
import { useDialog } from '../../ui/dialog.js';
import {
  clampSidebarWidth,
  RAIL_WIDTH,
  railVertical,
  SIDEBAR_WIDTH,
  sidebarAuto,
} from '../../ui/layout.js';
import { createPaneResize } from '../../ui/pane-resize.js';
import { useToast } from '../../ui/toast.js';
import { ApprovalBar, pendingFor } from './approval-bar.js';
import { Timeline } from './timeline.js';

export const SESSION_KEYS =
  'enter expand · d diff · c cancel · r resume · ctrl+b sidebar · ctrl+o runs · ? help';
export const STREAM_KEYS = 'enter expand · d diff · c cancel · q quit';

/** One run as a conversation: header, timeline, the approval bar or key hints, and the sidebar. */
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

  const summary = () => data.state.runs.find((r) => r.runId === props.runId);
  const state = () => data.state.states[props.runId];
  const status = () =>
    data.state.ended[props.runId] ?? state()?.status ?? summary()?.status ?? 'queued';
  const look = () => statusOf({ status: status() });
  const spent = () => state()?.spentUsd ?? summary()?.spentUsd ?? 0;
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
  const color = () => {
    const f = look().feedback;
    return f === 'muted' ? theme.text.muted : theme.text.feedback[f];
  };
  const pending = createMemo(() => pendingFor(data.state.inbox, props.runId));

  // sidebar: automatic on wide terminals, toggled with ctrl+b, resizable with the mouse
  const rail = () => (props.single ? 0 : railVertical(dimensions().width) ? RAIL_WIDTH : 0);
  const area = () => dimensions().width - rail();
  const [openedByKey, setOpenedByKey] = createSignal<boolean | undefined>(undefined);
  const sidebarVisible = createMemo(() => {
    if (props.single) return false;
    if (openedByKey() !== undefined) return openedByKey() as boolean;
    return prefs.data.sidebar !== 'hide' && sidebarAuto(dimensions().width, rail());
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
        message={`Cancel run ${shortId(props.runId)}?`}
        onYes={() => {
          dialog.close();
          void data.actions.cancel(props.runId);
        }}
        onNo={() => dialog.close()}
      />
    ));
  const resume = () => {
    if (status() === 'paused_budget') void data.actions.resume(props.runId);
    else toast.show({ message: 'Nothing to resume', variant: 'info' });
  };
  const unregister = useCommands().register([
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
    if (key.name === 'c' && !key.ctrl) {
      cancel();
      return true;
    }
    if (key.name === 'r') {
      resume();
      return true;
    }
    return false;
  });

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
        <box
          height={1}
          flexShrink={0}
          flexDirection="row"
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={theme.background.raised.base}
        >
          <text fg={theme.text.base} attributes={TextAttributes.BOLD} wrapMode="none">
            {`${shortId(props.runId)} · ${summary()?.workflow ?? state()?.workflow ?? ''} · `}
          </text>
          <Show
            when={status() === 'running'}
            fallback={<text fg={color()} wrapMode="none">{`${look().symbol} ${look().word}`}</text>}
          >
            <ShimmerText
              fg={color()}
              shimmer={theme.text.base}
              wrapMode="none"
            >{`${look().symbol} ${look().word}`}</ShimmerText>
          </Show>
          <text fg={theme.text.muted} wrapMode="none">
            {` · ${money(spent())}${elapsed() ? ` · ${elapsed()}` : ''}`}
          </text>
        </box>
        <Timeline runId={props.runId} focused={focus() === 'conversation'} />
        <Show
          when={pending().length > 0}
          fallback={<Footer left="" right={props.single ? STREAM_KEYS : SESSION_KEYS} />}
        >
          <ApprovalBar runId={props.runId} />
        </Show>
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
          runId={props.runId}
          width={sidebarWidth()}
          focused={focus() === 'sidebar'}
          onFocusBack={() => setFocus('conversation')}
        />
      </Show>
    </box>
  );
}
