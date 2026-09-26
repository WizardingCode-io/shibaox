import { TextAttributes } from '@opentui/core';
import type { RunSummaryPlus } from '@shibaox/daemon';
import { createMemo, createSignal, For, type JSX, Show } from 'solid-js';
import { useData } from '../context/data.js';
import { useKeys } from '../context/keys.js';
import { age, money, shortId } from '../model/format.js';
import { statusOf } from '../model/status.js';
import { pendingFor } from '../routes/session/approval-bar.js';
import { useTheme } from '../theme/context.js';
import { marqueeText } from '../ui/marquee.js';

type Group = 'Today' | 'Yesterday' | 'Earlier';

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/** Runs grouped by the day they were created, newest first. */
export function groupRuns(
  runs: RunSummaryPlus[],
  now = Date.now(),
): { group: Group; runs: RunSummaryPlus[] }[] {
  const today = dayKey(new Date(now));
  const yesterday = dayKey(new Date(now - 24 * 3600_000));
  const groups = new Map<Group, RunSummaryPlus[]>();
  for (const r of [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    const key = dayKey(new Date(r.createdAt));
    const g: Group = key === today ? 'Today' : key === yesterday ? 'Yesterday' : 'Earlier';
    groups.set(g, [...(groups.get(g) ?? []), r]);
  }
  return (['Today', 'Yesterday', 'Earlier'] as Group[])
    .filter((g) => groups.has(g))
    .map((g) => ({ group: g, runs: groups.get(g) ?? [] }));
}

function Title(props: { text: string }): JSX.Element {
  const theme = useTheme();
  return (
    <box height={1} flexShrink={0} marginTop={1}>
      <text fg={theme.text.base} attributes={TextAttributes.BOLD} wrapMode="none">
        {props.text}
      </text>
    </box>
  );
}

/** Runs by day, the pending inbox, and the current run's files and costs. */
export function Sidebar(props: {
  runId: string;
  width: number;
  focused: boolean;
  onFocusBack: () => void;
}): JSX.Element {
  const data = useData();
  const theme = useTheme().surface('sidebar');
  const groups = createMemo(() => groupRuns(data.state.runs));
  const flat = createMemo(() => groups().flatMap((g) => g.runs));
  const [cursor, setCursor] = createSignal(0);
  const selected = () => flat()[Math.min(cursor(), Math.max(0, flat().length - 1))];
  const cards = data.timeline(props.runId);
  const files = createMemo(() => {
    const out = new Set<string>();
    for (const c of cards()) {
      if (c.kind === 'node') for (const b of c.blocks) if (b.kind === 'file') out.add(b.path);
      if (c.kind === 'summary') for (const f of c.files) out.add(f);
    }
    return [...out];
  });
  const costs = createMemo(() =>
    cards().flatMap((c) =>
      c.kind === 'node' && c.costUsd !== undefined ? [{ nodeId: c.nodeId, usd: c.costUsd }] : [],
    ),
  );
  const inner = () => Math.max(8, props.width - 2);

  useKeys('pane', (key) => {
    if (!props.focused) return false;
    const n = flat().length;
    switch (key.name) {
      case 'j':
      case 'down':
        if (cursor() < n - 1) setCursor((c) => c + 1);
        return true;
      case 'k':
      case 'up':
        if (cursor() > 0) setCursor((c) => c - 1);
        return true;
      case 'return': {
        const r = selected();
        if (r) data.openRun(r.runId);
        return true;
      }
      case 'a':
      case 'd': {
        const r = selected();
        const item = r ? pendingFor(data.state.inbox, r.runId)[0] : undefined;
        if (item) void data.actions.answer(item.id, key.name === 'a');
        return true;
      }
      default:
        return false;
    }
  });

  const rowColor = (r: RunSummaryPlus) => {
    const f = statusOf({ status: r.status }).feedback;
    return f === 'muted' ? theme.text.muted : theme.text.feedback[f];
  };

  return (
    <box
      width={props.width}
      flexShrink={0}
      height="100%"
      flexDirection="column"
      backgroundColor={theme.background.base}
      paddingLeft={1}
      paddingRight={1}
    >
      <Title text="Runs" />
      <For each={groups()}>
        {(g) => (
          <box flexDirection="column" flexShrink={0}>
            <box height={1} flexShrink={0}>
              <text fg={theme.text.muted} wrapMode="none">
                {g.group}
              </text>
            </box>
            <For each={g.runs}>
              {(r) => (
                <box
                  height={1}
                  flexShrink={0}
                  flexDirection="row"
                  backgroundColor={
                    props.focused && selected()?.runId === r.runId
                      ? theme.background.action.primary.selected
                      : undefined
                  }
                  onMouseUp={() => data.openRun(r.runId)}
                >
                  <text
                    fg={rowColor(r)}
                    wrapMode="none"
                  >{`${statusOf({ status: r.status }).symbol} `}</text>
                  <text fg={theme.text.base} wrapMode="none">
                    {marqueeText(`${shortId(r.runId)} ${r.workflow}`, inner() - 8, 0)}
                  </text>
                  <box flexGrow={1} />
                  <text fg={theme.text.muted} wrapMode="none">
                    {age(r.createdAt)}
                  </text>
                </box>
              )}
            </For>
          </box>
        )}
      </For>
      <Title text={`Needs you (${data.state.inbox.length})`} />
      <For each={data.state.inbox}>
        {(i) => (
          <box height={1} flexShrink={0}>
            <text fg={theme.text.feedback.warning} wrapMode="none">
              {marqueeText(`▲ ${shortId(i.runId)} · ${i.prompt}`, inner(), 0)}
            </text>
          </box>
        )}
      </For>
      <Title text="This run" />
      <Show when={files().length === 0 && costs().length === 0}>
        <box height={1} flexShrink={0}>
          <text fg={theme.text.muted}>nothing yet</text>
        </box>
      </Show>
      <For each={files()}>
        {(f) => (
          <box height={1} flexShrink={0}>
            <text fg={theme.text.base} wrapMode="none">
              {marqueeText(`± ${f}`, inner(), 0)}
            </text>
          </box>
        )}
      </For>
      <For each={costs()}>
        {(c) => (
          <box height={1} flexShrink={0}>
            <text fg={theme.text.muted} wrapMode="none">{`${c.nodeId} ${money(c.usd)}`}</text>
          </box>
        )}
      </For>
      <box flexGrow={1} />
      <Show when={props.focused}>
        <box height={1} flexShrink={0}>
          <text fg={theme.text.muted} wrapMode="none">
            j/k select · enter open · a/d answer · tab back
          </text>
        </box>
      </Show>
    </box>
  );
}
