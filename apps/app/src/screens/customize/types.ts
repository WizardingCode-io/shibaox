/**
 * App-only types of the Customize screen. The API shapes come from `@wizardingcode/shibaox-daemon`;
 * the aliases below keep the screen's names.
 */
import type {
  Brings,
  HiggsfieldMode,
  HiggsfieldView,
  McpServerRow,
  PluginMode,
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

// ---- Higgsfield in two modes (account, API): the daemon's shapes under the screen's names
export type HiggsfieldEffective = HiggsfieldView['effective'];
export type PluginRowModes = PluginRow;
export type HiggsfieldViewModes = HiggsfieldView;
export type SkillAddReq = SkillAddRequest;
export type { Brings, HiggsfieldMode, PluginMode };

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
