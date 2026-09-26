import { describe, expect, it } from 'vitest';
import { statusOf } from '../src/model/status.js';

describe('statusOf', () => {
  it('maps every run status to a word, a symbol and a feedback colour', () => {
    expect(statusOf({ status: 'running' })).toEqual({
      word: 'Working',
      symbol: '●',
      feedback: 'running',
    });
    expect(statusOf({ status: 'waiting_human' })).toEqual({
      word: 'Needs you',
      symbol: '●',
      feedback: 'warning',
    });
    expect(statusOf({ status: 'waiting_approval' }).word).toBe('Needs you');
    expect(statusOf({ status: 'queued' })).toEqual({
      word: 'Queued',
      symbol: '○',
      feedback: 'muted',
    });
    expect(statusOf({ status: 'completed' })).toEqual({
      word: 'Done',
      symbol: '✓',
      feedback: 'success',
    });
    expect(statusOf({ status: 'failed' })).toEqual({
      word: 'Failed',
      symbol: '✗',
      feedback: 'error',
    });
    expect(statusOf({ status: 'paused_budget' })).toEqual({
      word: 'Paused',
      symbol: '‖',
      feedback: 'warning',
    });
    expect(statusOf({ status: 'cancelled' })).toEqual({
      word: 'Cancelled',
      symbol: '—',
      feedback: 'muted',
    });
  });
});
