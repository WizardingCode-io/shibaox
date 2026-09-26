import { TextAttributes } from '@opentui/core';
import { For, type JSX } from 'solid-js';
import { useTheme } from '../../theme/context.js';

export interface Suggestion {
  label: string;
  insert: string;
}

/** The suggestion list above the prompt: up to six rows, the selected one highlighted. */
export function Autocomplete(props: { items: Suggestion[]; selected: number }): JSX.Element {
  const theme = useTheme();
  return (
    <box
      flexDirection="column"
      backgroundColor={theme.background.raised.base}
      paddingLeft={1}
      paddingRight={1}
    >
      <For each={props.items.slice(0, 6)}>
        {(item, i) => (
          <box
            height={1}
            flexShrink={0}
            backgroundColor={
              i() === props.selected ? theme.background.action.primary.selected : undefined
            }
          >
            <text
              fg={i() === props.selected ? theme.text.action.primary.selected : theme.text.base}
              attributes={i() === props.selected ? TextAttributes.BOLD : undefined}
            >
              {item.label}
            </text>
          </box>
        )}
      </For>
    </box>
  );
}
