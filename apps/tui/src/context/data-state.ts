import type { RunState, RunStatus } from '@shibaox/core';
import type { Envelope, Health, InboxItem, RunSummaryPlus } from '@shibaox/daemon';

/** Everything the screens read; fed by the Poller and by user actions. */
export interface DataState {
  health?: Health;
  reachable: boolean;
  /** When the daemon stopped answering (ms epoch), for the delayed "reconnecting" overlay. */
  unreachableSince?: number;
  runs: RunSummaryPlus[];
  inbox: InboxItem[];
  states: Record<string, RunState>;
  frames: Record<string, Envelope[]>;
  ended: Record<string, RunStatus>;
  /** Open tabs (run ids) in order; `active` undefined means the home tab. */
  open: string[];
  active?: string;
  /** Runs with something the user has not looked at yet (tab pulse). */
  unread: Record<string, 'done' | 'needs'>;
}

export const initialData = (): DataState => ({
  reachable: true,
  runs: [],
  inbox: [],
  states: {},
  frames: {},
  ended: {},
  open: [],
  unread: {},
});

/** Frames kept per run (the cards cap at 5000; frames are a few per card). */
export const FRAME_LIMIT = 20_000;
