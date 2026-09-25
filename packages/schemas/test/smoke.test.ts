import { describe, expect, it } from 'vitest';
import { SCHEMAS_VERSION } from '../src/index.js';

describe('schemas package', () => {
  it('exports a version', () => {
    expect(SCHEMAS_VERSION).toBe('0.0.1');
  });
});
