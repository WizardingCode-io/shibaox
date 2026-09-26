import { existsSync } from 'node:fs';
import { selectCapabilities } from '@shibaox/core';
import { JevClient, noulFanOut } from '@shibaox/jev';
import { Graphify, graphJsonPath } from '@shibaox/memory';
import type { Org, Workflow } from '@shibaox/schemas';
import type { AdapterId, GraphWiring } from '../runtime.js';

export type GraphMode = 'auto' | 'off';

export interface GraphOptions {
  log: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  /** `auto` (default): use `graphify-out/graph.json` when it exists; never builds it. */
  graph?: GraphMode;
  /** Graphify runner (tests inject one with a fake exec). */
  graphify?: Graphify;
}

/** The first task role of the workflow (its `start` node when that is a task). */
function firstTaskRole(workflow: Workflow): string | undefined {
  const start = workflow.nodes[workflow.start];
  if (start?.type === 'task') return start.role;
  for (const node of Object.values(workflow.nodes)) if (node.type === 'task') return node.role;
  return undefined;
}

/**
 * Autorouting v0, once per run: the org catalog against the workflow's first task role,
 * deterministic without Jev, fanned out through Jev when it is configured (and the run is
 * not a mock run). `undefined` when the org has no catalog.
 */
async function autoroute(
  org: Org,
  workflow: Workflow,
  request: string,
  opts: { adapter: AdapterId; env: NodeJS.ProcessEnv; log: (l: string) => void },
) {
  const catalog = Object.values(org.catalog);
  const roleName = firstTaskRole(workflow);
  const role = roleName ? org.roles[roleName] : undefined;
  if (catalog.length === 0 || !role) return undefined;
  const team = workflow.team ? org.teams[workflow.team] : undefined;
  const key = opts.env.TYPESAFE_API_KEY;
  const fanOut =
    key && opts.adapter !== 'mock'
      ? noulFanOut(
          new JevClient({ apiKey: key, baseURL: opts.env.SHIBAOX_JEV_BASE_URL || undefined }),
        )
      : undefined;
  let r: Awaited<ReturnType<typeof selectCapabilities>>;
  try {
    r = await selectCapabilities({ request, role, team, catalog, fanOut });
  } catch (err) {
    opts.log(
      `warn: autorouting via Jev failed (${err instanceof Error ? err.message : String(err)}): using tag matching`,
    );
    r = await selectCapabilities({ request, role, team, catalog });
  }
  opts.log(`autoroute: attach=[${r.attach.join(', ')}] ambiguous=[${r.ambiguous.join(', ')}]`);
  return r;
}

/**
 * Wires the project's knowledge graph when `graphify-out/graph.json` exists (it is never
 * built here): `graph_query` for direct roles, the graphify MCP server for Claude Code roles
 * when autorouting attaches `graphify-mcp` or the catalog does not list it.
 */
export async function prepareGraph(args: {
  project: string;
  org: Org;
  workflow: Workflow | undefined;
  request: string;
  adapter: AdapterId;
  opts: GraphOptions;
}): Promise<GraphWiring | undefined> {
  const { project, org, workflow, adapter, opts } = args;
  const log = opts.log;
  const env = opts.env ?? process.env;
  const routed = workflow
    ? await autoroute(org, workflow, args.request, { adapter, env, log })
    : undefined;
  const graphJson = graphJsonPath(project);
  if ((opts.graph ?? 'auto') === 'off' || adapter === 'mock' || !existsSync(graphJson))
    return undefined;
  const graphify = opts.graphify ?? new Graphify();
  const wiring: GraphWiring = { query: (q) => graphify.query(project, q) };
  log(`graph: ${graphJson}`);
  if (adapter !== 'claude-code') return wiring;
  const listed = org.catalog['graphify-mcp'] !== undefined;
  if (listed && !routed?.attach.includes('graphify-mcp')) return wiring;
  const python = await graphify.pythonPath();
  if (!python) {
    log(
      'warn: graphify python not found (install: uv tool install graphifyy): graph MCP not attached',
    );
    return wiring;
  }
  return { ...wiring, mcpServers: { graphify: graphify.mcpServerConfig(graphJson, python) } };
}
