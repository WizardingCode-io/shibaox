import type { CatalogEntry, Cost, Role, Team } from '@wizardingcode/shibaox-schemas';

/** A catalog entry narrowed to the kinds `selectCapabilities` can attach. */
export interface CapabilityCandidate {
  id: string;
  type: 'skill' | 'plugin' | 'mcp' | 'tool';
  description: string;
  tags: string[];
}

export interface AutorouteArgs {
  request: string;
  role: Role;
  team?: Team;
  catalog: CatalogEntry[];
  /**
   * Fans a `noul` question out per candidate, injected so core never depends
   * on `@wizardingcode/shibaox-jev`. Answers missing a candidate (or a `noul`) count as 0.
   */
  fanOut?: (
    state: string,
    questions: Record<string, { instructions: string }>,
  ) => Promise<Record<string, { noul?: number }>>;
  thresholds?: { attach: number; ask: number };
}

export interface AutorouteResult {
  attach: string[];
  ambiguous: string[];
  dropped: string[];
  cost?: Cost;
}

const MAX_CANDIDATES = 40;
/** Upper bound on the request text forwarded to `fanOut`, to cap fan-out cost/payload size. */
export const AUTOROUTE_REQUEST_MAX_CHARS = 20_000;
const DEFAULT_THRESHOLDS = { attach: 0.8, ask: 0.5 };
const CANDIDATE_TYPES = new Set<CapabilityCandidate['type']>(['skill', 'plugin', 'mcp', 'tool']);

function isCandidateType(type: CatalogEntry['type']): type is CapabilityCandidate['type'] {
  return CANDIDATE_TYPES.has(type as CapabilityCandidate['type']);
}

function roleTagSet(role: Role, team?: Team): Set<string> {
  return new Set([role.role, ...role.capabilities, ...role.tools, ...(team?.roles ?? [])]);
}

function matchesRole(tags: string[], roleTags: Set<string>): boolean {
  return tags.some((t) => roleTags.has(t));
}

/**
 * Prefilters the catalog against the role/team's tags, caps it at
 * `MAX_CANDIDATES` (preferring tag matches), then either splits
 * deterministically by tag match (no `fanOut`) or fans a `noul` question out
 * per candidate and buckets by `thresholds`.
 */
export async function selectCapabilities(args: AutorouteArgs): Promise<AutorouteResult> {
  const roleTags = roleTagSet(args.role, args.team);
  // an entry with a `server` is attached by the roles that list it (`mcp:`), never by tags
  const pool: CapabilityCandidate[] = args.catalog
    .filter((e) => isCandidateType(e.type) && !e.server)
    .map((e) => ({
      id: e.id,
      type: e.type as CapabilityCandidate['type'],
      description: e.description,
      tags: e.tags,
    }));

  const matching = pool.filter((c) => matchesRole(c.tags, roleTags));
  const rest = pool.filter((c) => !matchesRole(c.tags, roleTags));
  const candidates = [...matching, ...rest].slice(0, MAX_CANDIDATES);

  if (!args.fanOut) {
    const attach: string[] = [];
    const ambiguous: string[] = [];
    for (const c of candidates) {
      (matchesRole(c.tags, roleTags) ? attach : ambiguous).push(c.id);
    }
    return { attach, ambiguous, dropped: [] };
  }

  const thresholds = { ...DEFAULT_THRESHOLDS, ...args.thresholds };
  const questions = Object.fromEntries(
    candidates.map((c) => [
      c.id,
      { instructions: `The capability ${c.id} (${c.description}) is needed for this request` },
    ]),
  );
  const boundedRequest = args.request.slice(0, AUTOROUTE_REQUEST_MAX_CHARS);
  const answers = await args.fanOut(boundedRequest, questions);
  const attach: string[] = [];
  const ambiguous: string[] = [];
  const dropped: string[] = [];
  for (const c of candidates) {
    const noul = answers[c.id]?.noul ?? 0;
    if (noul >= thresholds.attach) attach.push(c.id);
    else if (noul >= thresholds.ask) ambiguous.push(c.id);
    else dropped.push(c.id);
  }
  return { attach, ambiguous, dropped };
}
