/**
 * App-only types of the Customize screen. The API shapes come from `@wizardingcode/shibaox-daemon`
 * (`SkillRow`, `RoleRow`, `McpServerRow`, `ConnectorTemplate`, `SkillSource`, `PluginRow`, the
 * request and result types); what the daemon does not export yet is declared here, marked
 * `TODO daemon export`, with the shape the daemon answers with.
 */
import type {
  McpServerRow,
  SkillAddResult,
  SkillRow,
  SkipReason,
} from '@wizardingcode/shibaox-daemon';
import type { McpServer } from '@wizardingcode/shibaox-schemas';

// TODO daemon export: `GET /mcp` rows carry the raw catalog server (Edit… starts from it).
export type McpRow = McpServerRow & { server?: McpServer };

// TODO daemon export: `added[].omitted` (files over 1 MB left out) and the `copy_failed` reason.
export type SkillSkipReason = SkipReason | 'copy_failed';
export interface AddedSkill extends SkillRow {
  /** Files of the skill that were not copied (over 1 MB). */
  omitted?: string[];
}
export interface AddSkillOutcome extends Omit<SkillAddResult, 'added' | 'skipped'> {
  added: AddedSkill[];
  skipped: { id: string; reason: SkillSkipReason }[];
}

// TODO daemon export: `GET /skills/:id?org=` (a skill with its SKILL.md).
export interface SkillDoc {
  id: string;
  name: string;
  description: string;
  path: string;
  roles: string[];
  content: string;
}

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
