import { useTerminalDimensions } from '@opentui/solid';
import type { JSX } from 'solid-js';
import { useTheme } from '../theme/context.js';
import { stringWidth, takeWidth } from '../ui/marquee.js';

/** The last line: status on the left, keys on the right; the left side yields when space is short. */
export function Footer(props: { left: string; right: string }): JSX.Element {
  const theme = useTheme();
  const dimensions = useTerminalDimensions();
  const left = () => {
    const room = dimensions().width - 2 - stringWidth(props.right) - 3;
    return stringWidth(props.left) > room ? takeWidth(props.left, Math.max(0, room)) : props.left;
  };
  return (
    <box
      height={1}
      flexShrink={0}
      flexDirection="row"
      paddingLeft={1}
      paddingRight={1}
      width="100%"
    >
      <text fg={theme.text.muted} flexShrink={0} wrapMode="none">
        {left()}
      </text>
      <box flexGrow={1} />
      <text fg={theme.text.muted} flexShrink={0} wrapMode="none">
        {props.right}
      </text>
    </box>
  );
}
