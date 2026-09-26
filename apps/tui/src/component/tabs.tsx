import { TextAttributes } from '@opentui/core';
import { createEffect, createSignal, For, type JSX, onCleanup, Show } from 'solid-js';
import { useData } from '../context/data.js';
import { shortId } from '../model/format.js';
import { statusOf } from '../model/status.js';
import { useMotion } from '../motion/config.js';
import { completionPulseOpacity } from '../motion/pulse.js';
import { useTheme } from '../theme/context.js';
import { RAIL_WIDTH } from '../ui/layout.js';
import { marqueeText } from '../ui/marquee.js';
import { tint } from './logo.js';

const PULSE_MS = 1200;
const PULSES = 3;

/** 0..1 pulse level for an unread tab: three attack/decay beats, then rest (motion only). */
function usePulse(unread: () => boolean) {
  const motion = useMotion();
  const [level, setLevel] = createSignal(0);
  createEffect(() => {
    if (!unread() || !motion()) {
      setLevel(0);
      return;
    }
    const started = performance.now();
    const t = setInterval(() => {
      const elapsed = performance.now() - started;
      if (elapsed >= PULSE_MS * PULSES) {
        setLevel(0);
        clearInterval(t);
        return;
      }
      setLevel(completionPulseOpacity((elapsed % PULSE_MS) / PULSE_MS));
    }, 50);
    onCleanup(() => clearInterval(t));
  });
  return level;
}

function Tab(props: { runId?: string; vertical: boolean }): JSX.Element {
  const data = useData();
  const theme = useTheme();
  const active = () => data.state.active === props.runId;
  const unread = () => (props.runId ? data.state.unread[props.runId] : undefined);
  const pulse = usePulse(() => !!unread());
  const summary = () =>
    props.runId ? data.state.runs.find((r) => r.runId === props.runId) : undefined;
  const status = () =>
    (props.runId
      ? (data.state.ended[props.runId] ??
        data.state.states[props.runId]?.status ??
        summary()?.status)
      : undefined) ?? 'queued';
  const look = () => statusOf({ status: status() });
  const feedback = () => {
    const f = look().feedback;
    return f === 'muted' ? theme.text.muted : theme.text.feedback[f];
  };
  const pulseColor = () =>
    unread() === 'needs' ? theme.text.feedback.warning : theme.text.feedback.success;
  const bg = () => {
    const base = active() ? theme.background.action.primary.selected : theme.background.raised.base;
    return pulse() > 0 ? tint(base, pulseColor(), pulse() * 0.5) : base;
  };
  const label = () =>
    props.runId ? `${look().symbol} ${shortId(props.runId)}${unread() ? ' •' : ''}` : '⌂ home';
  const sub = () => marqueeText(summary()?.workflow ?? '', RAIL_WIDTH - 4, 0);
  const activate = () => data.activate(props.runId);
  return (
    <Show
      when={props.vertical}
      fallback={
        <box
          flexDirection="row"
          flexShrink={0}
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={bg()}
          onMouseUp={activate}
        >
          <text
            fg={props.runId ? feedback() : theme.text.base}
            attributes={active() ? TextAttributes.BOLD : undefined}
            wrapMode="none"
          >
            {label()}
          </text>
        </box>
      }
    >
      <box
        flexDirection="row"
        width="100%"
        flexShrink={0}
        backgroundColor={bg()}
        onMouseUp={activate}
      >
        <text
          fg={active() ? theme.text.action.primary.selected : theme.background.raised.base}
          flexShrink={0}
        >
          {'┃ '}
        </text>
        <box flexDirection="column" flexGrow={1}>
          <box height={1}>
            <text
              fg={props.runId ? feedback() : theme.text.base}
              attributes={active() ? TextAttributes.BOLD : undefined}
              wrapMode="none"
            >
              {label()}
            </text>
          </box>
          <Show when={props.runId}>
            <box height={1}>
              <text fg={theme.text.muted} wrapMode="none">
                {sub()}
              </text>
            </box>
          </Show>
        </box>
      </box>
    </Show>
  );
}

/** The open runs as tabs: a vertical rail on wide terminals, one line on top otherwise. */
export function Tabs(props: { vertical: boolean }): JSX.Element {
  const data = useData();
  const theme = useTheme();
  return (
    <Show
      when={props.vertical}
      fallback={
        <box
          height={1}
          flexShrink={0}
          flexDirection="row"
          width="100%"
          backgroundColor={theme.background.raised.base}
        >
          <Tab vertical={false} />
          <For each={data.state.open}>{(id) => <Tab runId={id} vertical={false} />}</For>
        </box>
      }
    >
      <box
        width={RAIL_WIDTH}
        flexShrink={0}
        height="100%"
        flexDirection="column"
        backgroundColor={theme.background.raised.base}
        paddingTop={1}
      >
        <Tab vertical />
        <box height={1} flexShrink={0} />
        <For each={data.state.open}>{(id) => <Tab runId={id} vertical />}</For>
      </box>
    </Show>
  );
}
