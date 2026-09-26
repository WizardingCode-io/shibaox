export const RAIL_WIDTH = 20;
export const RAIL_BREAKPOINT = 106;
export const SIDEBAR_WIDTH = 42;
export const SIDEBAR_MIN = 24;
export const SIDEBAR_MAX = 72;
export const CONTENT_MIN = 44;
export const SIDEBAR_AUTO_MIN = 120;
export const MIN_COLS = 60;
export const MIN_ROWS = 15;

/** The tabs rail stands on the left from 106 columns; below that it is one line on top. */
export const railVertical = (width: number): boolean => width >= RAIL_BREAKPOINT;

/** The sidebar opens by itself when the content keeps 120 columns beside the rail. */
export const sidebarAuto = (width: number, rail: number): boolean =>
  width - rail >= SIDEBAR_AUTO_MIN;

/** A sidebar width between 24 and 72 that leaves the content at least 44 columns. */
export const clampSidebarWidth = (w: number, total: number): number =>
  Math.max(SIDEBAR_MIN, Math.min(w, SIDEBAR_MAX, total - CONTENT_MIN));

export const tooSmall = (width: number, height: number): boolean =>
  width < MIN_COLS || height < MIN_ROWS;
