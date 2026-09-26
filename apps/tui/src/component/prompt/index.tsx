import type { InputRenderable } from '@opentui/core';
import { createEffect, createMemo, createSignal, type JSX, onCleanup, Show } from 'solid-js';
import { useKeys } from '../../context/keys.js';
import {
  completeCommand,
  type PromptCommand,
  parsePromptCommand,
} from '../../model/prompt-commands.js';
import { useMotion } from '../../motion/config.js';
import { useTheme } from '../../theme/context.js';
import { Autocomplete } from './autocomplete.js';

export interface PromptRef {
  focus(): void;
  set(text: string): void;
  current(): string;
  clear(): void;
}

const PLACEHOLDER_MS = 4000;

/**
 * The input of the home screen: `/` commands autocomplete (↑/↓ choose, tab/enter insert), enter
 * with a command calls onCommand, enter with text calls onSubmit; ctrl+c clears the text.
 */
export function Prompt(props: {
  ref?: (r: PromptRef) => void;
  placeholders: string[];
  disabled?: boolean;
  workflows: string[];
  onSubmit(text: string): void;
  onCommand(cmd: PromptCommand): void;
}): JSX.Element {
  const theme = useTheme();
  const motion = useMotion();
  let input: InputRenderable | undefined;
  const [text, setText] = createSignal('');
  const [selected, setSelected] = createSignal(0);
  const [placeholder, setPlaceholder] = createSignal(0);
  const suggestions = createMemo(() => completeCommand(text(), { workflows: props.workflows }));
  createEffect(() => {
    suggestions();
    setSelected(0);
  });
  createEffect(() => {
    if (!motion() || props.placeholders.length < 2) return;
    const t = setInterval(
      () => setPlaceholder((i) => (i + 1) % props.placeholders.length),
      PLACEHOLDER_MS,
    );
    onCleanup(() => clearInterval(t));
  });

  const set = (value: string) => {
    if (input) input.value = value;
    setText(value);
  };
  const api: PromptRef = {
    focus: () => input?.focus(),
    set,
    current: text,
    clear: () => set(''),
  };
  props.ref?.(api);

  const accept = () => {
    const s = suggestions()[selected()];
    if (!s) return;
    set(s.insert);
  };
  const submit = () => {
    if (props.disabled) return;
    let value = text().trim();
    if (!value) return;
    if (value.startsWith('/')) {
      // a partial argument takes the highlighted suggestion (`/workflow hel` → hello-feature)
      const s = suggestions()[selected()];
      if (s && s.insert.trim() !== value && s.insert.startsWith(value.split(/\s+/)[0] ?? '')) {
        const parsed = parsePromptCommand(value);
        if (!parsed || (parsed.arg && s.insert.trim() !== value)) value = s.insert.trim();
      }
      const cmd = parsePromptCommand(value);
      if (cmd) {
        set('');
        props.onCommand(cmd);
        return;
      }
    }
    props.onSubmit(value);
  };

  useKeys('prompt', (key) => {
    if (key.ctrl && key.name === 'c') {
      if (!text()) return false;
      set('');
      return true;
    }
    if (key.name === '?') return true; // typed into the input, never the help shortcut
    if (suggestions().length === 0) return false;
    if (key.name === 'up') {
      setSelected((i) => (i - 1 + suggestions().length) % suggestions().length);
      return true;
    }
    if (key.name === 'down') {
      setSelected((i) => (i + 1) % suggestions().length);
      return true;
    }
    if (key.name === 'tab') {
      accept();
      return true;
    }
    return false;
  });

  return (
    <box flexDirection="column" width="100%">
      <Show when={suggestions().length > 0}>
        <Autocomplete items={suggestions()} selected={selected()} />
      </Show>
      <box
        width="100%"
        border={['top']}
        borderColor={theme.text.action.primary.selected}
        paddingLeft={1}
        paddingRight={1}
        paddingTop={1}
        paddingBottom={1}
        backgroundColor={theme.background.raised.base}
      >
        <box flexDirection="row" width="100%">
          <text fg={theme.text.action.primary.selected} flexShrink={0}>
            {'› '}
          </text>
          <input
            ref={(r: InputRenderable) => {
              input = r;
            }}
            focused={!props.disabled}
            placeholder={props.placeholders[placeholder()] ?? ''}
            onInput={setText}
            onSubmit={submit}
            flexGrow={1}
            backgroundColor={theme.background.raised.base}
            focusedBackgroundColor={theme.background.raised.base}
            textColor={theme.text.base}
            placeholderColor={theme.text.muted}
            cursorColor={theme.text.action.primary.selected}
          />
        </box>
      </box>
    </box>
  );
}
