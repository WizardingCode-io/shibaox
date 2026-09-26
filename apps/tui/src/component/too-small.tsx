import type { JSX } from 'solid-js';
import { useTheme } from '../theme/context.js';
import { MIN_COLS, MIN_ROWS } from '../ui/layout.js';

/** Replaces the page when the terminal is under 60×15. */
export function TooSmall(): JSX.Element {
  const theme = useTheme();
  return (
    <box width="100%" height="100%" alignItems="center" justifyContent="center">
      <text
        fg={theme.text.feedback.warning}
      >{`Terminal too small (${MIN_COLS}×${MIN_ROWS} minimum)`}</text>
    </box>
  );
}
