import { TextAttributes } from '@opentui/core';
import { For, type JSX } from 'solid-js';
import { SUGGESTIONS, type Suggestion } from '../../model/prompt-commands.js';
import { useTheme } from '../../theme/context.js';

export type { Suggestion } from '../../model/prompt-commands.js';

/** The suggestion list above the prompt: up to ten rows, the selected one highlighted. */
export function Autocomplete(props: { items: Suggestion[]; selected: number }): JSX.Element {
  const theme = useTheme();
  return (
    <box
      flexDirection="column"
      backgroundColor={theme.background.raised.base}
      paddingLeft={1}
      paddingRight={1}
    >
      <For each={props.items.slice(0, SUGGESTIONS)}>
        {(item, i) => (
          <box
            height={1}
            flexShrink={0}
            flexDirection="row"
            backgroundColor={
              i() === props.selected ? theme.background.action.primary.selected : undefined
            }
          >
            <text
              fg={i() === props.selected ? theme.text.action.primary.selected : theme.text.base}
              attributes={i() === props.selected ? TextAttributes.BOLD : undefined}
              wrapMode="none"
              flexShrink={0}
            >
              {item.label}
            </text>
            <text fg={theme.text.muted} wrapMode="none" flexShrink={1}>
              {item.hint ? `  ${item.hint}` : ''}
            </text>
          </box>
        )}
      </For>
    </box>
  );
}
