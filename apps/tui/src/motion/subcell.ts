// Adapted from opencode (MIT) — https://github.com/anomalyco/opencode
// Masks use row-major bits in a 2x4 grid. Unicode reuses these older glyphs
// instead of duplicating them in the otherwise mask-ordered octant block.
const OCTANTS = new Map<number, string>([
  [0x00, ' '],
  [0x01, '\u{1cea8}'],
  [0x02, '\u{1ceab}'],
  [0x03, '\u{1fb82}'],
  [0x05, '▘'],
  [0x0a, '▝'],
  [0x0f, '▀'],
  [0x14, '\u{1fbe6}'],
  [0x28, '\u{1fbe7}'],
  [0x3f, '\u{1fb85}'],
  [0x40, '\u{1cea3}'],
  [0x50, '▖'],
  [0x55, '▌'],
  [0x5a, '▞'],
  [0x5f, '▛'],
  [0x80, '\u{1cea0}'],
  [0xa0, '▗'],
  [0xa5, '▚'],
  [0xaa, '▐'],
  [0xaf, '▜'],
  [0xc0, '▂'],
  [0xf0, '▄'],
  [0xf5, '▙'],
  [0xfa, '▟'],
  [0xfc, '▆'],
  [0xff, '█'],
]);

export function octantGlyph(mask: number): string {
  return (
    OCTANTS.get(mask) ??
    String.fromCodePoint(
      0x1cd00 + mask - [...OCTANTS.keys()].filter((value) => value < mask).length,
    )
  );
}
