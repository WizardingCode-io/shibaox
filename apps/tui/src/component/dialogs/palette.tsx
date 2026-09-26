import { TextAttributes } from '@opentui/core';
import fuzzysort from 'fuzzysort';
import { createMemo, createSignal, For, type JSX } from 'solid-js';
import { useCommands } from '../../context/commands.js';
import { useKeys } from '../../context/keys.js';
import { useTheme } from '../../theme/context.js';
import { Dialog, useDialog } from '../../ui/dialog.js';

/** Every available command with its keys; enter runs the selected one. */
export function PaletteDialog(): JSX.Element {
  const registry = useCommands();
  const dialog = useDialog();
  const theme = useTheme().surface('dialog');
  const [query, setQuery] = createSignal('');
  const [cursor, setCursor] = createSignal(0);
  const rows = createMemo(() => {
    const all = registry.commands().filter((c) => c.when?.() ?? true);
    const q = query().trim();
    if (!q) return all;
    return fuzzysort.go(q, all, { key: 'label' }).map((r) => r.obj);
  });
  const run = () => {
    const c = rows()[Math.min(cursor(), rows().length - 1)];
    if (!c) return;
    dialog.close();
    c.run();
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
      run();
      return true;
    }
    return false;
  });
  return (
    <Dialog title="Commands" onClose={() => dialog.close()}>
      <box height={1} flexShrink={0} flexDirection="row" marginBottom={1}>
        <text fg={theme.text.action.primary.selected} flexShrink={0}>
          {'› '}
        </text>
        <input
          focused
          placeholder="type a command"
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
      <For each={rows().slice(0, 12)}>
        {(c, i) => {
          const selected = () => i() === Math.min(cursor(), rows().length - 1);
          return (
            <box
              height={1}
              flexShrink={0}
              flexDirection="row"
              backgroundColor={selected() ? theme.background.action.primary.selected : undefined}
              onMouseUp={() => {
                setCursor(i());
                run();
              }}
            >
              <text
                fg={theme.text.base}
                attributes={selected() ? TextAttributes.BOLD : undefined}
                wrapMode="none"
              >
                {c.label}
              </text>
              <box flexGrow={1} />
              <text fg={theme.text.muted} wrapMode="none">
                {c.keys}
              </text>
            </box>
          );
        }}
      </For>
    </Dialog>
  );
}
