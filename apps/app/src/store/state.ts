import type { RunState, RunStatus } from '@wizardingcode/shibaox-core';
import type { Health, InboxItem, RunSummaryPlus } from '@wizardingcode/shibaox-daemon';
import type { Card } from '@wizardingcode/shibaox-view';

export interface Settings {
  theme: 'light' | 'dark' | 'system';
  /** The project new chats start in (else the first the daemon offers). */
  project?: string;
  /** The org new chats use (else the daemon's default org). */
  org?: string;
  /** The model new chats run on (`provider/model`); else the org's tiers decide. */
  model?: string;
  /** How the sidebar addresses you. */
  name?: string;
}

/** Everything the screens read; fed by the poller, the run streams and the user's actions. */
export interface AppState {
  health?: Health;
  reachable: boolean;
  runs: RunSummaryPlus[];
  inbox: InboxItem[];
  states: Record<string, RunState>;
  /** The timeline of each run the app has streamed (from `reduceTimeline`). */
  cards: Record<string, Card[]>;
  /** How each streamed run ended, once it did. */
  ended: Record<string, RunStatus>;
  /** The thread (root run id) on screen. */
  open?: string;
  /** Threads with a turn being submitted. */
  busy: Record<string, boolean>;
  settings: Settings;
  /** The last error worth a toast. */
  error?: string;
}

export const initialState = (settings: Settings): AppState => ({
  reachable: true,
  runs: [],
  inbox: [],
  states: {},
  cards: {},
  ended: {},
  busy: {},
  settings,
});

export const TERMINAL: ReadonlySet<RunStatus> = new Set(['completed', 'failed', 'cancelled']);
