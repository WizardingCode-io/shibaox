/**
 * The shapes of the Customize API (docs/superpowers/specs/2026-10-01-customize-design.md),
 * defined on the app side: the daemon builds the same routes against the same shapes.
 */

/** One skill of the org: `org/skills/<id>/SKILL.md`. */
export interface SkillRow {
  id: string;
  /** The frontmatter `name`, else the id. */
  name: string;
  /** The frontmatter `description`, else the first paragraph. */
  description: string;
  path: string;
  /** The roles that list it under `skills:`. */
  roles: string[];
}

/** `POST /skills?org=`: from a repository, a folder on the daemon's machine, or written here. */
export type AddSkillRequest =
  | { source: 'repo'; repo: string; path?: string; ids?: string[] }
  | { source: 'folder'; path: string }
  | { source: 'inline'; id: string; content: string };

export interface AddSkillResult {
  added: SkillRow[];
  skipped: { id: string; reason: string }[];
}

/** One skill a repository offers (`GET /skills/discover`). */
export interface DiscoveredSkill {
  id: string;
  name: string;
  description: string;
  path: string;
}
export interface DiscoverResult {
  repo: string;
  skills: DiscoveredSkill[];
}

/** One role of the org (`GET /roles?org=`). */
export interface RoleRow {
  id: string;
  name: string;
  model?: string;
  tools: string[];
  mcp: string[];
  skills: string[];
}

/** `PUT /roles/:id?org=`: the lists to replace. */
export interface RoleLinks {
  mcp?: string[];
  skills?: string[];
}

/** How to reach an MCP server (the catalog's `server:`), as the app sends it. */
export interface McpServerSpec {
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  env_keys?: string[];
  headers?: Record<string, string>;
  bearer_command?: string[];
  tools?: string[];
  timeout_ms?: number;
}

/** `POST /mcp?org=`: writes `catalog/<id>.yaml` and attaches the roles. */
export interface AddMcpRequest {
  id: string;
  description: string;
  tags?: string[];
  server: McpServerSpec;
  roles?: string[];
  replace?: boolean;
}

/** One connector of the built-in registry (`GET /registry/connectors`). */
export interface ConnectorTemplate {
  id: string;
  name: string;
  vendor: string;
  verified: boolean;
  category: string;
  description: string;
  keys: { name: string; signupUrl?: string; description: string }[];
  server: McpServerSpec;
  skills?: string[];
  /** e.g. "signs in on first use" for an OAuth server without keys. */
  note?: string;
}

/** One built-in skill source (`GET /registry/skills`); its listing comes from `/skills/discover`. */
export interface SkillSource {
  repo: string;
  name: string;
  vendor: string;
  description: string;
  path?: string;
  categories?: string[];
}

/** One partner integration (`GET /plugins`). */
export interface PluginRow {
  id: string;
  name: string;
  description: string;
  status: 'ready' | 'partial' | 'off';
  checks: { label: string; ok: boolean; detail?: string }[];
  keys: { name: string; present: boolean }[];
  actions: { id: string; label: string; href?: string }[];
  brings: { connectors: string[]; skills: string[] };
}

/** The connector categories of the registry, in the order the filter shows them. */
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
