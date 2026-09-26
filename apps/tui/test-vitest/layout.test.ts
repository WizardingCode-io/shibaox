import { describe, expect, it } from 'vitest';
import { clampSidebarWidth, railVertical, sidebarAuto } from '../src/ui/layout.js';

describe('layout rules', () => {
  it('rail is vertical from 106 columns', () => {
    expect(railVertical(105)).toBe(false);
    expect(railVertical(106)).toBe(true);
  });
  it('sidebar opens by itself when the content keeps 120 columns', () => {
    expect(sidebarAuto(140, 20)).toBe(true);
    expect(sidebarAuto(125, 20)).toBe(false);
  });
  it('sidebar width stays between 24 and 72 and leaves 44 for the content', () => {
    expect(clampSidebarWidth(100, 140)).toBe(72);
    expect(clampSidebarWidth(10, 140)).toBe(24);
    expect(clampSidebarWidth(60, 100)).toBe(56);
  });
});
