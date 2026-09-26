import { TextAttributes } from '@opentui/core';
import { createEffect, createSignal, For, type JSX, onCleanup } from 'solid-js';
import { useData } from '../context/data.js';
import { shortId } from '../model/format.js';
import { statusOf } from '../model/status.js';
import { useMotion } from '../motion/config.js';
import { completionPulseOpacity } from '../motion/pulse.js';
import { useTheme } from '../theme/context.js';
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

function Tab(props: { runId?: string }): JSX.Element {
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
    const base = active() ? theme.background.raised.high : theme.background.raised.base;
    return pulse() > 0 ? tint(base, pulseColor(), pulse() * 0.5) : base;
  };
  const label = () =>
    props.runId
      ? `${look().symbol} ${shortId(props.runId)} ${summary()?.workflow ?? ''}${unread() ? ' •' : ''}`
      : '⌂';
  return (
    <box
      flexDirection="row"
      flexShrink={0}
      height={1}
      paddingLeft={2}
      paddingRight={2}
      backgroundColor={bg()}
      onMouseUp={() => data.activate(props.runId)}
    >
      <text
        fg={props.runId ? (active() ? theme.text.base : theme.text.muted) : theme.text.base}
        attributes={active() ? TextAttributes.BOLD : undefined}
        wrapMode="none"
      >
        {props.runId ? '' : label()}
      </text>
      {props.runId ? (
        <>
          <text fg={feedback()} wrapMode="none">{`${look().symbol} `}</text>
          <text
            fg={active() ? theme.text.base : theme.text.muted}
            attributes={active() ? TextAttributes.BOLD : undefined}
            wrapMode="none"
          >
            {`${shortId(props.runId)} ${summary()?.workflow ?? ''}${unread() ? ' •' : ''}`}
          </text>
        </>
      ) : null}
    </box>
  );
}

/** One line of tabs on top: home, then every open run. Only shown while runs are open. */
export function Tabs(): JSX.Element {
  const data = useData();
  const theme = useTheme();
  return (
    <box
      height={1}
      flexShrink={0}
      flexDirection="row"
      width="100%"
      backgroundColor={theme.background.raised.base}
    >
      <Tab />
      <For each={data.state.open}>{(id) => <Tab runId={id} />}</For>
    </box>
  );
}
