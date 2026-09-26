import { RGBA } from '@opentui/core';
import { describe, expect, it } from 'vitest';
import shibaox from '../src/theme/shibaox.json' with { type: 'json' };
import { resolveTheme, syntaxStyles } from '../src/theme/resolve.js';

describe('resolveTheme', () => {
  it('resolves hex and $ references into RGBA tokens', () => {
    const t = resolveTheme(shibaox);
    expect(t.text.base.equals(RGBA.fromHex('#f7ede2'))).toBe(true);
    expect(t.text.muted.equals(RGBA.fromHex('#b9a694'))).toBe(true);
    expect(t.background.base.equals(RGBA.fromHex('#140e0a'))).toBe(true);
    expect(t.text.feedback.success.equals(RGBA.fromHex('#6acb8e'))).toBe(true);
    // $text.base chains through $hue.neutral.200
    expect(t.text.action.primary.base.equals(t.text.base)).toBe(true);
  });

  it('rejects an unresolved reference', () => {
    const broken = JSON.parse(JSON.stringify(shibaox));
    broken.text.muted = '$hue.pink.200';
    expect(() => resolveTheme(broken)).toThrow('theme: unresolved $hue.pink.200');
  });

  it('re-resolves a surface one level up', () => {
    const t = resolveTheme(shibaox);
    const d = t.surface('dialog');
    expect(d.background.base.equals(t.background.raised.base)).toBe(true);
    expect(d.background.raised.base.equals(t.background.raised.high)).toBe(true);
    expect(d.background.raised.high.equals(t.background.raised.max)).toBe(true);
    expect(d.text.base.equals(t.text.base)).toBe(true);
  });

  it('produces syntax styles for markdown and code', () => {
    const s = syntaxStyles(resolveTheme(shibaox));
    expect(s['markup.heading']?.bold).toBe(true);
    expect(s.keyword?.fg).toBeDefined();
    expect(s.default?.fg).toBeDefined();
  });
});
