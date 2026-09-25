import assert from 'node:assert/strict';
import { test } from 'node:test';
import { add } from './math.js';

test('add', () => {
  assert.equal(add(2, 2), 4);
});
