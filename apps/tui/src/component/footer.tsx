import { TextAttributes } from '@opentui/core';
import { useTerminalDimensions } from '@opentui/solid';
import { For, type JSX } from 'solid-js';
import { useTheme } from '../theme/context.js';
import { stringWidth, takeWidth } from '../ui/marquee.js';

export interface KeyHint {
  key: string;
  label: string;
}

/** `key label · key label` with the keys in bold, as one row of texts. */
export function KeyHints(props: { hints: KeyHint[] }): JSX.Element {
  const theme = useTheme();
  return (
    <box flexDirection="row" flexShrink={0}>
      <For each={props.hints}>
        {(h, i) => (
          <>
            {i() > 0 ? <text fg={theme.text.muted}>{'  '}</text> : null}
            <text fg={theme.text.base} attributes={TextAttributes.BOLD} wrapMode="none">
              {h.key}
            </text>
            <text fg={theme.text.muted} wrapMode="none">{` ${h.label}`}</text>
          </>
        )}
      </For>
    </box>
  );
}

/** The last line: status on the left, key hints on the right; the left side yields when space is short. */
export function Footer(props: { left: string; hints?: KeyHint[]; right?: string }): JSX.Element {
  const theme = useTheme();
  const dimensions = useTerminalDimensions();
  const rightWidth = () =>
    props.right
      ? stringWidth(props.right)
      : (props.hints ?? []).reduce((w, h) => w + stringWidth(h.key) + stringWidth(h.label) + 3, 0);
  const left = () => {
    const room = dimensions().width - 4 - rightWidth();
    return stringWidth(props.left) > room ? takeWidth(props.left, Math.max(0, room)) : props.left;
  };
  return (
    <box
      height={1}
      flexShrink={0}
      flexDirection="row"
      paddingLeft={2}
      paddingRight={2}
      width="100%"
    >
      <text fg={theme.text.muted} flexShrink={1} wrapMode="none">
        {left()}
      </text>
      <box flexGrow={1} flexShrink={0} width={2} />
      {props.right ? (
        <text fg={theme.text.muted} flexShrink={0} wrapMode="none">
          {props.right}
        </text>
      ) : (
        <KeyHints hints={props.hints ?? []} />
      )}
    </box>
  );
}
