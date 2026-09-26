import { describe, expect, it } from 'vitest';
import { motionEnabled, statusOf } from '../src/theme.js';

describe('theme', () => {
  it('maps every run status to a word and a symbol', () => {
    expect(statusOf({ status: 'running' })).toEqual({
      word: 'Working',
      symbol: '●',
      color: '#86aef5',
    });
    expect(statusOf({ status: 'waiting_approval' }).word).toBe('Needs you');
    expect(statusOf({ status: 'waiting_human' }).word).toBe('Needs you');
    expect(statusOf({ status: 'queued' })).toMatchObject({ word: 'Queued', symbol: '○' });
    expect(statusOf({ status: 'completed' })).toMatchObject({ word: 'Done', symbol: '✓' });
    expect(statusOf({ status: 'failed' })).toMatchObject({
      word: 'Failed',
      symbol: '✗',
      color: '#ff7a8a',
    });
    expect(statusOf({ status: 'paused_budget' })).toMatchObject({ word: 'Paused', symbol: '‖' });
    expect(statusOf({ status: 'cancelled' })).toMatchObject({ word: 'Cancelled', symbol: '—' });
  });

  it('motion follows SHIBAOX_NO_MOTION', () => {
    expect(motionEnabled({})).toBe(true);
    expect(motionEnabled({ SHIBAOX_NO_MOTION: '1' })).toBe(false);
  });
});
