import type { ProjectProfile, RunState, RunStatus } from '@wizardingcode/shibaox-core';
import type {
  Health,
  InboxItem,
  KeyRow,
  McpServerRow,
  OrgConfig,
  OrgInfo,
  RoutineView,
  RunSummaryPlus,
} from '@wizardingcode/shibaox-daemon';
import type { ModelChoice } from '@wizardingcode/shibaox-providers';
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
  /** The daemon refused the token: back to Connect. */
  unauthorized?: boolean;
  /** The sections, loaded when opened. */
  routines?: RoutineView[];
  /** The projects the daemon offers (for the routine dialog). */
  projects?: { path: string; source?: string }[];
  skills?: {
    org: string;
    workflows: { name: string; description: string; conversation: boolean }[];
    catalog: NonNullable<OrgInfo['catalog']>;
  };
  memory?: { project?: string; profile?: ProjectProfile; org?: OrgConfig; error?: string };
  integrations?: {
    org: string;
    mcp: McpServerRow[];
    models: ModelChoice[];
    keys: KeyRow[];
    config?: OrgConfig;
  };
  /** A model chosen for the next turns of a thread (`provider/model`). */
  threadModels: Record<string, string>;
}

export const initialState = (settings: Settings): AppState => ({
  reachable: true,
  runs: [],
  inbox: [],
  states: {},
  cards: {},
  ended: {},
  busy: {},
  threadModels: {},
  settings,
});

export const TERMINAL: ReadonlySet<RunStatus> = new Set(['completed', 'failed', 'cancelled']);
