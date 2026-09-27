import { expect, test } from 'bun:test';
import { priceLabel, windowLabel } from '../src/model/prompt-commands.js';

test('small prices keep their digits instead of rounding to $0.00', () => {
  expect(priceLabel({ pricing: { input_per_m: 0.004, output_per_m: 0.075 } })).toBe(
    '$0.004/$0.075 per M',
  );
  expect(priceLabel({ pricing: { input_per_m: 1.25, output_per_m: 10 } })).toBe(
    '$1.25/$10.00 per M',
  );
  expect(priceLabel({ pricing: { input_per_m: 0, output_per_m: 0 } })).toBe('free');
  expect(priceLabel({ free: true })).toBe('free');
  expect(priceLabel({})).toBeUndefined();
  expect(windowLabel(131072)).toBe('131k ctx');
  expect(windowLabel(1048576)).toBe('1.0M ctx');
});
