/** Dark-theme tokens of the Shibaox design system, reduced to what a terminal can show. */
export const colors = {
  focus: '#ffa15c', // shiba-strong: selection, focus
  success: '#6acb8e', // matcha
  running: '#86aef5', // info
  attention: '#f2c150', // warning
  danger: '#ff7a8a', // danger
  muted: '#b9a694', // ink-muted
} as const;

export type StatusWord =
  | 'Working'
  | 'Needs you'
  | 'Queued'
  | 'Done'
  | 'Failed'
  | 'Paused'
  | 'Cancelled';

export interface StatusLook {
  word: StatusWord;
  symbol: string;
  color: string;
}

/** A run status as a word plus a symbol (never colour alone). */
export function statusOf(run: { status: string }): StatusLook {
  switch (run.status) {
    case 'running':
      return { word: 'Working', symbol: '●', color: colors.running };
    case 'waiting_human':
    case 'waiting_approval':
      return { word: 'Needs you', symbol: '●', color: colors.attention };
    case 'queued':
      return { word: 'Queued', symbol: '○', color: colors.muted };
    case 'completed':
      return { word: 'Done', symbol: '✓', color: colors.success };
    case 'failed':
      return { word: 'Failed', symbol: '✗', color: colors.danger };
    case 'paused_budget':
      return { word: 'Paused', symbol: '‖', color: colors.attention };
    default:
      return { word: 'Cancelled', symbol: '—', color: colors.muted };
  }
}

export const motionEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.SHIBAOX_NO_MOTION !== '1';

/** Frames of the working indicator (three rounded bars, like the design system's Wave). */
export const WAVE_FRAMES = ['▁▃▅', '▃▅▁', '▅▁▃'] as const;
