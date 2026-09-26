/** The footer line; every action key the dashboard understands. */
export const KEY_HELP =
  'j/k select · enter detail · tab pane · a/d answer · n note · i inbox · N new run · c cancel · r resume · f filter · ? help · q quit';

export const HELP_LINES = [
  'j/k or ↑/↓   move the selection (list) or scroll (detail)',
  'enter        focus the run detail',
  'tab          switch panes',
  'a / d        approve / deny the first inbox item',
  'n            approve with a note',
  'i            open the inbox list',
  'N            new run',
  'c            cancel the selected run',
  'r            resume the selected run',
  'f            filter: active / all',
  '?            this help',
  'q / esc      quit (the daemon keeps running)',
] as const;

/** Below this width the dashboard shows one pane at a time. */
export const NARROW_COLUMNS = 100;
export const MIN_COLUMNS = 60;
export const MIN_ROWS = 15;
export const LIST_WIDTH = 22;
