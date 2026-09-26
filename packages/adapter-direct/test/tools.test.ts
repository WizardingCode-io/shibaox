import { describe, expect, it } from 'vitest';
import { leavesWorkspace } from '../src/tools.js';

describe('leavesWorkspace', () => {
  it('sees through a grouped short option to a value with a `..` segment', () => {
    expect(leavesWorkspace('-rf../x')).toBe(true);
  });
  it('does not flag a bare grouped short option with no value', () => {
    expect(leavesWorkspace('-rf')).toBe(false);
  });
  it('allows a short option value that stays inside the workspace', () => {
    expect(leavesWorkspace('-o./out')).toBe(false);
  });
  it('flags a short option value that is an absolute path', () => {
    expect(leavesWorkspace('-o/etc/x')).toBe(true);
  });
});
