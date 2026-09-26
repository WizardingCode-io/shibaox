// Adapted from opencode (MIT) — https://github.com/anomalyco/opencode
const GAP = ' · ';
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Terminal cell width of a grapheme: 2 for East Asian wide/fullwidth and most emoji, else 1. */
export function graphemeWidth(g: string): number {
  const cp = g.codePointAt(0) ?? 0;
  if (cp < 0x1100) return 1;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
    return 2;
  return 1;
}

export function graphemes(value: string): string[] {
  return [...segmenter.segment(value)].map((s) => s.segment);
}

export function stringWidth(value: string): number {
  return graphemes(value).reduce((w, g) => w + graphemeWidth(g), 0);
}

/** The longest prefix of `value` that fits in `width` cells. */
export function takeWidth(value: string, width: number): string {
  let out = '';
  let w = 0;
  for (const g of graphemes(value)) {
    const gw = graphemeWidth(g);
    if (w + gw > width) break;
    out += g;
    w += gw;
  }
  return out;
}

export function marqueeCycleWidth(value: string): number {
  return stringWidth(value + GAP);
}

export function marqueeOverflows(value: string, width: number): boolean {
  return stringWidth(value) > width;
}

/** `value` scrolled by `offset` cells inside `width`, looping with a ` · ` gap; unscrolled when it fits. */
export function marqueeText(value: string, width: number, offset: number): string {
  if (width <= 0) return '';
  if (stringWidth(value) <= width || offset <= 0) return takeWidth(value, width);
  const loop = [...graphemes(value), ...graphemes(GAP)];
  const cursor = offset % marqueeCycleWidth(value);
  const parts = [...loop, ...loop];
  let start = 0;
  let skipped = 0;
  while (start < parts.length && skipped < cursor) {
    skipped += graphemeWidth(parts[start] ?? '');
    start++;
  }
  let out = '';
  let w = 0;
  for (const g of parts.slice(start)) {
    const gw = graphemeWidth(g);
    if (w + gw > width) break;
    out += g;
    w += gw;
  }
  return out;
}
