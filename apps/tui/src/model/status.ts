import type { Feedback } from '../theme/resolve.js';

export type StatusWord =
  | 'Working'
  | 'Needs you'
  | 'Queued'
  | 'Done'
  | 'Failed'
  | 'Paused'
  | 'Cancelled';

export interface StatusLook {
  word: StatusWord;
  symbol: string;
  feedback: Feedback | 'muted';
}

/** A run status as a word plus a symbol (never colour alone). */
export function statusOf(run: { status: string }): StatusLook {
  switch (run.status) {
    case 'running':
      return { word: 'Working', symbol: '●', feedback: 'running' };
    case 'waiting_human':
    case 'waiting_approval':
      return { word: 'Needs you', symbol: '●', feedback: 'warning' };
    case 'queued':
      return { word: 'Queued', symbol: '○', feedback: 'muted' };
    case 'completed':
      return { word: 'Done', symbol: '✓', feedback: 'success' };
    case 'failed':
      return { word: 'Failed', symbol: '✗', feedback: 'error' };
    case 'paused_budget':
      return { word: 'Paused', symbol: '‖', feedback: 'warning' };
    default:
      return { word: 'Cancelled', symbol: '—', feedback: 'muted' };
  }
}

/** A node status as a symbol plus feedback colour. */
export function nodeLook(status: string): { symbol: string; feedback: Feedback | 'muted' } {
  switch (status) {
    case 'running':
      return { symbol: '●', feedback: 'running' };
    case 'waiting':
      return { symbol: '●', feedback: 'warning' };
    case 'completed':
    case 'passed':
      return { symbol: '✓', feedback: 'success' };
    case 'failed':
    case 'gate_failed':
      return { symbol: '✗', feedback: 'error' };
    default:
      return { symbol: '○', feedback: 'muted' };
  }
}
