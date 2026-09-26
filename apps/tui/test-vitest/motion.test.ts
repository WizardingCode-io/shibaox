import { describe, expect, it } from 'vitest';
import { createAnimatable, spring } from '../src/motion/animation.js';
import { oneCellFrame, SEED_LAUNCH, WORK_SPINNERS } from '../src/motion/one-cell-motion.js';
import { coast, intensityAt, smootherstep } from '../src/motion/pulse.js';
import { octantGlyph } from '../src/motion/subcell.js';
import { marqueeText } from '../src/ui/marquee.js';

describe('one-cell motion', () => {
  it('yields an octant glyph that never completes for a work spinner', () => {
    const f = oneCellFrame(WORK_SPINNERS['block-soft-sweep'], 0);
    expect(f.glyph.length).toBeGreaterThan(0);
    expect(f.complete).toBe(false);
    expect(oneCellFrame(WORK_SPINNERS['block-soft-sweep'], 5_000).complete).toBe(false);
  });
  it('completes a once-only launch animation', () => {
    expect(oneCellFrame(SEED_LAUNCH, 10_000).complete).toBe(true);
  });
  it('maps octant masks to glyphs', () => {
    expect(octantGlyph(0xff)).toBe('█');
    expect(octantGlyph(0x00)).toBe(' ');
  });
});

describe('pulse math', () => {
  it('coast and smootherstep are anchored at 0 and 1', () => {
    expect(coast(0)).toBe(0);
    expect(coast(1)).toBeCloseTo(1);
    expect(smootherstep(0)).toBe(0);
    expect(smootherstep(1)).toBe(1);
  });
  it('intensity peaks at the front', () => {
    expect(intensityAt(5, 5, 4, 18)).toBe(1);
    expect(intensityAt(30, 5, 4, 18)).toBe(0);
  });
});

describe('marquee', () => {
  it('cuts to the width without an offset and scrolls with one', () => {
    expect(marqueeText('hello-feature', 8, 0)).toBe('hello-fe');
    expect(marqueeText('hello-feature', 8, 3).startsWith('lo-')).toBe(true);
    expect(marqueeText('short', 8, 3)).toBe('short');
  });
});

describe('createAnimatable', () => {
  it('jumps to the target when motion is disabled', () => {
    const a = createAnimatable(
      { w: 10 },
      { transition: spring({ visualDuration: 0.2 }), enabled: () => false },
    );
    a.animate({ w: 20 });
    expect(a.value().w).toBe(20);
  });
});
