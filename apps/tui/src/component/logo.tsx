import { RGBA } from '@opentui/core';
import { useTerminalDimensions } from '@opentui/solid';
import type { JSX } from 'solid-js';
import { useTheme } from '../theme/context.js';

/** Blends `overlay` over `base` by `alpha` (the logo's shadow). */
export function tint(base: RGBA, overlay: RGBA, alpha: number): RGBA {
  const r = base.r + (overlay.r - base.r) * alpha;
  const g = base.g + (overlay.g - base.g) * alpha;
  const b = base.b + (overlay.b - base.b) * alpha;
  return RGBA.fromInts(Math.round(r * 255), Math.round(g * 255), Math.round(b * 255));
}

/** The shibaox wordmark in a block font (6 rows) with a shadow; smaller under 44 columns, gone under 20 rows. */
export function Logo(): JSX.Element {
  const theme = useTheme();
  const dimensions = useTerminalDimensions();
  const shadow = () => tint(theme.background.base, theme.text.action.primary.selected, 0.35);
  return (
    <box flexShrink={0}>
      {dimensions().height < 20 ? null : (
        <ascii_font
          text="shibaox"
          font={dimensions().width < 44 ? 'tiny' : 'block'}
          color={[theme.text.action.primary.selected, shadow()]}
          selectable={false}
        />
      )}
    </box>
  );
}
