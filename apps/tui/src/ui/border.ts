// Adapted from opencode (MIT) — https://github.com/anomalyco/opencode
export const EmptyBorder = {
  topLeft: '',
  bottomLeft: '',
  vertical: '',
  topRight: '',
  bottomRight: '',
  horizontal: ' ',
  bottomT: '',
  topT: '',
  cross: '',
  leftT: '',
  rightT: '',
};

/** Only the left and right edges, drawn as a heavy bar: cards, toasts, the active tab. */
export const SplitBorder = {
  border: ['left' as const, 'right' as const],
  customBorderChars: { ...EmptyBorder, vertical: '┃' },
};
