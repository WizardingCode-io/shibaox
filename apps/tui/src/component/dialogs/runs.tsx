import { TextAttributes } from '@opentui/core';
import fuzzysort from 'fuzzysort';
import { createMemo, createSignal, For, type JSX } from 'solid-js';
import { useData } from '../../context/data.js';
import { useKeys } from '../../context/keys.js';
import { age, money, shortId } from '../../model/format.js';
import { statusOf } from '../../model/status.js';
import { useTheme } from '../../theme/context.js';
import { Dialog, useDialog } from '../../ui/dialog.js';

const VISIBLE = 20;

/** Every run the daemon knows, filtered as you type; enter opens the selected one in a tab. */
export function RunsDialog(): JSX.Element {
  const data = useData();
  const dialog = useDialog();
  const theme = useTheme().surface('dialog');
  const [query, setQuery] = createSignal('');
  const [cursor, setCursor] = createSignal(0);
  const rows = createMemo(() => {
    const runs = [...data.state.runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const q = query().trim();
    if (!q) return runs;
    return fuzzysort
      .go(q, runs, { key: (r) => `${r.runId} ${r.workflow} ${r.status}` })
      .map((r) => r.obj);
  });
  const open = () => {
    const r = rows()[Math.min(cursor(), rows().length - 1)];
    if (!r) return;
    dialog.close();
    data.openRun(r.runId);
  };
  useKeys('dialog', (key) => {
    if (key.name === 'up') {
      setCursor((c) => Math.max(0, c - 1));
      return true;
    }
    if (key.name === 'down') {
      setCursor((c) => Math.min(rows().length - 1, c + 1));
      return true;
    }
    if (key.name === 'return') {
      open();
      return true;
    }
    return false;
  });
  const start = () =>
    Math.max(0, Math.min(cursor() - Math.floor(VISIBLE / 2), rows().length - VISIBLE));
  return (
    <Dialog size="large" title="Runs" onClose={() => dialog.close()}>
      <box height={1} flexShrink={0} flexDirection="row" marginBottom={1}>
        <text fg={theme.text.action.primary.selected} flexShrink={0}>
          {'› '}
        </text>
        <input
          focused
          placeholder="type to filter"
          onInput={(v: string) => {
            setQuery(v);
            setCursor(0);
          }}
          flexGrow={1}
          backgroundColor={theme.background.base}
          focusedBackgroundColor={theme.background.base}
          textColor={theme.text.base}
          placeholderColor={theme.text.muted}
          cursorColor={theme.text.action.primary.selected}
        />
      </box>
      <For each={rows().slice(start(), start() + VISIBLE)}>
        {(r, i) => {
          const selected = () => start() + i() === Math.min(cursor(), rows().length - 1);
          const look = () => statusOf({ status: r.status });
          const color = () => {
            const f = look().feedback;
            return f === 'muted' ? theme.text.muted : theme.text.feedback[f];
          };
          return (
            <box
              height={1}
              flexShrink={0}
              flexDirection="row"
              backgroundColor={selected() ? theme.background.action.primary.selected : undefined}
              onMouseUp={() => {
                setCursor(start() + i());
                open();
              }}
            >
              <text fg={color()} wrapMode="none">{`${look().symbol} `}</text>
              <text
                fg={theme.text.base}
                attributes={selected() ? TextAttributes.BOLD : undefined}
                wrapMode="none"
              >
                {`${shortId(r.runId)} ${r.workflow}`}
              </text>
              <box flexGrow={1} />
              <text
                fg={theme.text.muted}
                wrapMode="none"
              >{`${look().word} · ${age(r.createdAt)} · ${money(r.spentUsd)}`}</text>
            </box>
          );
        }}
      </For>
      <box height={1} flexShrink={0} marginTop={1}>
        <text fg={theme.text.muted} wrapMode="none">
          {rows().length === 0 ? 'No runs match' : '↑/↓ select · enter open · esc close'}
        </text>
      </box>
    </Dialog>
  );
}
