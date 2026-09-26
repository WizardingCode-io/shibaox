import { TextAttributes } from '@opentui/core';
import { createSignal, type JSX, onCleanup, Show } from 'solid-js';
import { Footer } from '../../component/footer.js';
import { useData } from '../../context/data.js';
import { duration, money, shortId } from '../../model/format.js';
import { statusOf } from '../../model/status.js';
import { ShimmerText } from '../../motion/shimmer-text.js';
import { useTheme } from '../../theme/context.js';
import { Timeline } from './timeline.js';

export const SESSION_KEYS = 'enter expand · d diff · c cancel · r resume · ctrl+o runs · ? help';
export const STREAM_KEYS = 'enter expand · d diff · c cancel · q quit';

/** One run as a conversation: header, timeline, and the approval bar or key hints at the bottom. */
export function SessionFrame(props: {
  runId: string;
  single?: boolean;
  focused?: boolean;
}): JSX.Element {
  const data = useData();
  const theme = useTheme();
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
  const focused = () => props.focused ?? true;

  return (
    <box flexDirection="column" width="100%" height="100%">
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
      <Timeline runId={props.runId} focused={focused()} />
      <Footer left="" right={props.single ? STREAM_KEYS : SESSION_KEYS} />
    </box>
  );
}
