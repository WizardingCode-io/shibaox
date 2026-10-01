/**
 * App-only types of the Customize screen. The API shapes come from `@wizardingcode/shibaox-daemon`;
 * the aliases below keep the screen's names.
 */
import type {
  HiggsfieldView,
  McpServerRow,
  PluginRow,
  SkillAdded,
  SkillAddRequest,
  SkillAddResult,
  SkillDetail,
  SkipReason,
} from '@wizardingcode/shibaox-daemon';

/** A connector row; the daemon always fills `server` (optional only for older daemons). */
export type McpRow = McpServerRow;
export type SkillSkipReason = SkipReason;
export type AddedSkill = SkillAdded;
export type AddSkillOutcome = SkillAddResult;
export type SkillDoc = SkillDetail;

// ---- Higgsfield in two modes (account, API): the daemon's shapes, declared here until it exports them

// TODO daemon export: `HiggsfieldMode` (partners.higgsfield.mode in daemon.yaml)
export type HiggsfieldMode = 'auto' | 'account' | 'api';
// TODO daemon export: what a task uses now (`effectiveHiggsfieldMode`)
export type HiggsfieldEffective = 'account' | 'api' | 'none';

// TODO daemon export: `Brings` with `tools?` and `builtin?`
/** What a plugin (or one of its modes) brings; `builtin` skills come from Shibaox's own template. */
export interface Brings {
  connectors: string[];
  skills: string[];
  /** Daemon tools the mode gives the agent (`higgsfield_api_generate`). */
  tools?: string[];
  /** Skills added from Shibaox's template (`{source:'builtin', id}`), not a vendor repository. */
  builtin?: string[];
}

// TODO daemon export: `PluginMode`
/** One way of using a plugin (Higgsfield: account or API), with its own setup. */
export interface PluginMode {
  id: string;
  name: string;
  description: string;
  /** The mode the plugin's top-level fields describe. */
  active: boolean;
  status: PluginRow['status'];
  checks: PluginRow['checks'];
  keys: PluginRow['keys'];
  actions: PluginRow['actions'];
  brings: Brings;
}

// TODO daemon export: `PluginRow.modes?` / `PluginRow.mode?`
/** A plugin row with its modes (top level = the active mode). */
export type PluginRowModes = Omit<PluginRow, 'brings'> & {
  brings: Brings;
  modes?: PluginMode[];
  mode?: { configured: HiggsfieldMode; effective: HiggsfieldEffective };
};

// TODO daemon export: `HiggsfieldView.api/mode/effective`
export type HiggsfieldViewModes = HiggsfieldView & {
  api?: { keySet: boolean; valid?: boolean | 'unknown'; status?: number; checkedAt?: string };
  mode?: HiggsfieldMode;
  effective?: HiggsfieldEffective;
};

// TODO daemon export: `SkillAddRequest |= {source:'builtin', id, replace?}`
export type SkillAddReq = SkillAddRequest | { source: 'builtin'; id: string; replace?: boolean };

/** The connector categories of the registry, in the order the filter shows them (the daemon's list). */
export const CONNECTOR_CATEGORIES = [
  'Code',
  'Browser',
  'Data',
  'Docs',
  'Design & media',
  'Productivity',
  'Infra',
  'Search',
] as const;

export type CustomizeTab = 'skills' | 'connectors' | 'plugins' | 'keys' | 'models';
export const CUSTOMIZE_TABS: { id: CustomizeTab; label: string }[] = [
  { id: 'skills', label: 'Skills' },
  { id: 'connectors', label: 'Connectors' },
  { id: 'plugins', label: 'Plugins' },
  { id: 'keys', label: 'Keys' },
  { id: 'models', label: 'Models' },
];
export type CustomizeView = 'yours' | 'discover';

/** Why a skill was not added, in words. */
export const SKIP_WORDS: Record<SkillSkipReason, string> = {
  exists: 'already in the org',
  invalid_id: 'not a valid id',
  symlink: 'a symbolic link (refused)',
  too_large: 'too large',
  not_found: 'not found in the source',
  copy_failed: 'the copy failed',
};
