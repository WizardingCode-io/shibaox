import { TextAttributes } from '@opentui/core';
import type { KeyRow } from '@wizardingcode/shibaox-daemon';
import { createMemo, createResource, createSignal, For, type JSX, Show } from 'solid-js';
import { useClient } from '../../context/client.js';
import { useKeys } from '../../context/keys.js';
import { useTheme } from '../../theme/context.js';
import { Dialog, useDialog } from '../../ui/dialog.js';
import { useToast } from '../../ui/toast.js';

const VISIBLE = 16;
/** The keys most people set first, ahead of the rest of the catalog. */
const PRIORITY = [
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'TYPESAFE_API_KEY',
  'SHIBAOX_TELEGRAM_TOKEN',
];

/** Set keys first, then the usual ones, then the rest by name. */
export function orderKeys(rows: readonly KeyRow[]): KeyRow[] {
  const rank = (r: KeyRow) => {
    const p = PRIORITY.indexOf(r.name);
    return (r.set ? 0 : 1000) + (p < 0 ? PRIORITY.length : p);
  };
  return [...rows].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/**
 * The key vault: ↑/↓ pick a key, enter types its value (masked) and enter again saves it,
 * `x` removes the selected one. Values never show on screen.
 */
export function KeysDialog(): JSX.Element {
  const client = useClient();
  const dialog = useDialog();
  const toast = useToast();
  const theme = useTheme().surface('dialog');
  const [rows, { refetch }] = createResource<KeyRow[]>(() => client.keys().catch(() => []));
  const sorted = createMemo(() => orderKeys(rows() ?? []));
  const [cursor, setCursor] = createSignal(0);
  /** After a save the list reorders (set keys first): the cursor stays on the same key. */
  const reload = async () => {
    const name = selected()?.name;
    await refetch();
    if (name) {
      const i = sorted().findIndex((r) => r.name === name);
      if (i >= 0) setCursor(i);
    }
  };
  const [editing, setEditing] = createSignal<string | undefined>();
  const [value, setValue] = createSignal('');
  const selected = () => sorted()[Math.min(cursor(), Math.max(0, sorted().length - 1))];
  const save = async () => {
    const name = editing();
    const v = value().trim();
    if (!name) return;
    if (!v) {
      setEditing(undefined);
      return;
    }
    try {
      await client.setKey(name, v);
      toast.show({ message: `${name} saved in the vault`, variant: 'success' });
      await reload();
    } catch (e) {
      toast.show({
        message: `Could not save ${name}: ${e instanceof Error ? e.message : String(e)}`,
        variant: 'error',
      });
    }
    setValue('');
    setEditing(undefined);
  };
  const remove = async () => {
    const r = selected();
    if (!r?.set || r.source !== 'vault') {
      if (r?.source === 'env')
        toast.show({ message: `${r.name} comes from the shell, not the vault`, variant: 'info' });
      return;
    }
    await client.unsetKey(r.name).catch(() => undefined);
    toast.show({ message: `${r.name} removed from the vault`, variant: 'info' });
    await reload();
  };
  useKeys('dialog', (key) => {
    if (editing()) return false; // the input owns the keys while a value is typed
    if (key.name === 'up') {
      setCursor((c) => Math.max(0, c - 1));
      return true;
    }
    if (key.name === 'down') {
      setCursor((c) => Math.min(sorted().length - 1, c + 1));
      return true;
    }
    if (key.name === 'return') {
      const r = selected();
      // the input mounts on the next tick: a focused input would receive this same enter
      if (r)
        setTimeout(() => {
          setValue('');
          setEditing(r.name);
        }, 0);
      return true;
    }
    if (key.name === 'x' && !key.ctrl) {
      void remove();
      return true;
    }
    return false;
  });
  const start = () =>
    Math.max(0, Math.min(cursor() - Math.floor(VISIBLE / 2), sorted().length - VISIBLE));
  const window = () => sorted().slice(start(), start() + VISIBLE);
  return (
    <Dialog size="large" title="Keys" onClose={() => dialog.close()}>
      <box flexDirection="column" width="100%">
        <Show when={rows.loading}>
          <text fg={theme.text.muted}>Reading the vault…</text>
        </Show>
        <For each={window()}>
          {(r, i) => {
            const active = () => start() + i() === cursor();
            return (
              <box
                height={1}
                flexShrink={0}
                flexDirection="row"
                backgroundColor={active() ? theme.background.action.primary.selected : undefined}
              >
                <text
                  fg={r.set ? theme.text.feedback.success : theme.text.muted}
                  wrapMode="none"
                  flexShrink={0}
                >
                  {r.set ? ' ● ' : ' ○ '}
                </text>
                <text
                  fg={active() ? theme.text.action.primary.selected : theme.text.base}
                  attributes={TextAttributes.BOLD}
                  wrapMode="none"
                  flexShrink={0}
                >
                  {r.name.padEnd(28)}
                </text>
                <text fg={theme.text.muted} wrapMode="none" flexShrink={0}>
                  {(r.set ? `${r.masked ?? ''} ${r.source ?? ''}` : 'missing').padEnd(22)}
                </text>
                <text fg={theme.text.muted} wrapMode="none" flexShrink={1}>
                  {r.description}
                </text>
              </box>
            );
          }}
        </For>
        <Show when={sorted().length > VISIBLE}>
          <box height={1} flexShrink={0}>
            <text fg={theme.text.muted} wrapMode="none">
              {`${cursor() + 1} of ${sorted().length}`}
            </text>
          </box>
        </Show>
        <box height={1} flexShrink={0} marginTop={1} flexDirection="row">
          <Show
            when={editing()}
            fallback={
              <text fg={theme.text.muted} wrapMode="none">
                {'↑/↓ choose · enter set a value · x remove · esc close'}
              </text>
            }
          >
            <text fg={theme.text.base} wrapMode="none" flexShrink={0}>
              {`value for ${editing() ?? ''}: `}
            </text>
            <text fg={theme.text.action.primary.selected} wrapMode="none" flexShrink={1}>
              {'•'.repeat(Math.min(value().length, 40))}
            </text>
            <text fg={theme.text.muted} wrapMode="none" flexShrink={0}>
              {value().length > 40 ? ` (${value().length} chars)` : ''}
            </text>
            {/* the real input carries the keys; its text is hidden behind the dots */}
            <input
              focused
              width={1}
              onInput={setValue}
              onSubmit={() => void save()}
              backgroundColor={theme.background.base}
              focusedBackgroundColor={theme.background.base}
              textColor={theme.background.base}
              placeholderColor={theme.background.base}
              cursorColor={theme.text.action.primary.selected}
            />
            <text fg={theme.text.muted} wrapMode="none" flexShrink={0}>
              {'  enter saves'}
            </text>
          </Show>
        </box>
      </box>
    </Dialog>
  );
}
