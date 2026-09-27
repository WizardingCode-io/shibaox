import type { InputRenderable } from '@opentui/core';
import { createSignal, type JSX } from 'solid-js';
import { useKeys } from '../../context/keys.js';
import { useTheme } from '../../theme/context.js';

const PLACEHOLDER = 'Continue… "Now add tests for it"';

/** The prompt at the bottom of a finished run: the next request runs in the same tab. */
export function ContinuePrompt(props: {
  onSubmit(text: string): void;
  onScroll?(lines: number): void;
}): JSX.Element {
  const theme = useTheme();
  const [text, setText] = createSignal('');
  let input: InputRenderable | undefined;
  useKeys('prompt', (key) => {
    if (key.ctrl && key.name === 'c') {
      if (!text()) return false;
      if (input && !input.isDestroyed) input.value = '';
      setText('');
      return true;
    }
    const scroll: Record<string, number> = { up: -2, down: 2, pageup: -20, pagedown: 20 };
    const lines = scroll[key.name];
    if (lines === undefined) return false;
    props.onScroll?.(lines);
    return true;
  });
  return (
    <box flexDirection="row" width="100%" height={1}>
      <text fg={theme.text.action.primary.selected} flexShrink={0}>
        {'› '}
      </text>
      <input
        ref={(r: InputRenderable) => {
          input = r;
        }}
        focused
        placeholder={PLACEHOLDER}
        onInput={setText}
        onSubmit={() => {
          const value = text().trim();
          if (!value) return;
          if (input && !input.isDestroyed) input.value = '';
          setText('');
          props.onSubmit(value);
        }}
        flexGrow={1}
        backgroundColor={theme.background.raised.base}
        focusedBackgroundColor={theme.background.raised.base}
        textColor={theme.text.base}
        placeholderColor={theme.text.muted}
        cursorColor={theme.text.action.primary.selected}
      />
    </box>
  );
}
