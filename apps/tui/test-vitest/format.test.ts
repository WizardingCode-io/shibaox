import { describe, expect, it } from 'vitest';
import { age, duration, money, shortId } from '../src/model/format.js';

describe('format', () => {
  it('money uses 4 decimals under a dollar and 2 above', () => {
    expect(money(0.002)).toBe('$0.0020');
    expect(money(0)).toBe('$0.0000');
    expect(money(1.5)).toBe('$1.50');
  });
  it('duration reads as seconds, minutes or hours', () => {
    expect(duration(41_000)).toBe('41 s');
    expect(duration(133_000)).toBe('2m 13s');
    expect(duration(3_840_000)).toBe('1h 04m');
    expect(duration(500)).toBe('0 s');
  });
  it('age is relative to now', () => {
    const now = Date.parse('2026-09-26T10:00:00Z');
    expect(age('2026-09-26T09:59:48Z', now)).toBe('12 s');
    expect(age('2026-09-26T09:57:00Z', now)).toBe('3 m');
    expect(age('2026-09-26T08:00:00Z', now)).toBe('2 h');
    expect(age('2026-09-22T10:00:00Z', now)).toBe('4 d');
  });
  it('shortId keeps 8 characters', () => {
    expect(shortId('fe4a4950-1234-5678')).toBe('fe4a4950');
  });
});
