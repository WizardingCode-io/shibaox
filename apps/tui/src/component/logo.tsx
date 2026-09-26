import { RGBA } from '@opentui/core';
import { useTerminalDimensions } from '@opentui/solid';
import type { JSX } from 'solid-js';
import { useTheme } from '../theme/context.js';

/** Blends `overlay` over `base` by `alpha`. */
export function tint(base: RGBA, overlay: RGBA, alpha: number): RGBA {
  const r = base.r + (overlay.r - base.r) * alpha;
  const g = base.g + (overlay.g - base.g) * alpha;
  const b = base.b + (overlay.b - base.b) * alpha;
  return RGBA.fromInts(Math.round(r * 255), Math.round(g * 255), Math.round(b * 255));
}

/** The wordmark in two tones: `shiba` muted, `ox` in the brand orange. Smaller under 60 columns, gone under 20 rows. */
export function Logo(): JSX.Element {
  const theme = useTheme();
  const dimensions = useTerminalDimensions();
  const font = () => (dimensions().width < 60 ? 'tiny' : 'block');
  return (
    <box flexShrink={0} flexDirection="row">
      {dimensions().height < 20 ? null : (
        <>
          <ascii_font text="shiba" font={font()} color={theme.text.muted} selectable={false} />
          <ascii_font text="ox" font={font()} color={theme.syntax.heading} selectable={false} />
        </>
      )}
    </box>
  );
}
