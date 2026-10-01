import type { Role } from '@wizardingcode/shibaox-schemas';

/** What a task gets from Higgsfield in the mode the daemon is in when the task starts. */
export interface HiggsfieldPlan {
  /** `higgsfield_api_*` (the key stays in the daemon). */
  apiTools: boolean;
  /** `higgsfield_upload` over the account's MCP. */
  upload: boolean;
  /** Higgsfield's MCP server is not started (API mode: never both paths). */
  skipMcp: boolean;
}

/**
 * The account path (the MCP server and its upload) or the API path (the daemon's REST tools),
 * never both: a role that uses Higgsfield (its server or its command) gets the API tools in
 * `api` mode; the MCP upload only in `account` mode with the server in the catalog.
 */
export function higgsfieldPlan(
  role: Pick<Role, 'mcp' | 'tools'>,
  mode: 'account' | 'api',
  hasCatalogServer: boolean,
): HiggsfieldPlan {
  const viaMcp = role.mcp.includes('higgsfield');
  const wants = viaMcp || role.tools.includes('higgsfield');
  return {
    apiTools: wants && mode === 'api',
    upload: mode === 'account' && viaMcp && hasCatalogServer,
    skipMcp: mode === 'api',
  };
}
