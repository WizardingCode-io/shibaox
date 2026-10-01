import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadOrg, ModelsSchema, OrgFileSchema } from '@wizardingcode/shibaox-schemas';
import { parseDocument } from 'yaml';

export type TierName = 'strong' | 'cheap' | 'decision';
export const TIER_NAMES: TierName[] = ['strong', 'cheap', 'decision'];
const ADAPTERS = ['mock', 'direct', 'claude-code'] as const;

/** What the dashboard and the CLI show and change about an org without editing YAML. */
export interface OrgConfig {
  root: string;
  organization: string;
  adapter?: 'mock' | 'direct' | 'claude-code';
  per_run_usd?: number;
  tiers: Partial<Record<TierName, string>>;
  /** `models.gates.judge`: the model of `judge` checks (default: decision, then strong). */
  judge?: string;
}

/** Values to change; `null` clears one (judge, adapter, budget: a tier cannot be cleared). */
export interface OrgConfigPatch {
  tiers?: Partial<Record<TierName, string | null>>;
  judge?: string | null;
  adapter?: OrgConfig['adapter'] | null;
  per_run_usd?: number | null;
}

const isModelRef = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-z0-9][a-z0-9-]*\/\S+$/i.test(v);
/** Jev (`jev-latest`) is a typed decision API, not a chat model: only the decision tier may name it. */
const isJev = (v: unknown): v is string => typeof v === 'string' && /^jev-[\w.-]+$/i.test(v);

/** What a dashboard needs to offer an org's workflows without reading its files itself. */
export interface OrgInfo {
  workflows: string[];
  /** Workflows marked `conversation: true` (the org's `chat`): they run in place. */
  single: string[];
  /** Whether the strong tier runs on a subscription runtime (Claude Code). */
  subscription: boolean;
  /** `org.yaml adapter`: the org's default runtime. */
  adapter?: 'mock' | 'direct' | 'claude-code';
  /** Each workflow's description (the app's Skills cards). */
  descriptions?: Record<string, string>;
  /** The catalog entries (skills, plugins, MCP servers, tools). */
  catalog?: { id: string; type: string; description: string }[];
}

/** The org's workflows and runtime hints; throws (`not found` in the message) when it is not an org. */
export function orgInfo(root: string): OrgInfo {
  const org = loadOrg(root);
  const strong = String(org.models.tiers?.strong ?? '');
  return {
    workflows: Object.keys(org.workflows),
    single: Object.values(org.workflows)
      .filter((w) => w.conversation)
      .map((w) => w.workflow),
    subscription: /-subscription\//.test(strong),
    adapter: org.org.adapter,
    descriptions: Object.fromEntries(
      Object.values(org.workflows).map((w) => [w.workflow, w.description ?? '']),
    ),
    catalog: Object.values(org.catalog).map((c) => ({
      id: c.id,
      type: c.type,
      description: c.description,
    })),
  };
}

export function readOrgConfig(root: string): OrgConfig {
  const org = loadOrg(root);
  return {
    root: org.root,
    organization: org.org.organization,
    adapter: org.org.adapter,
    per_run_usd: org.org.budgets.per_run_usd,
    tiers: {
      ...(org.models.tiers.strong ? { strong: org.models.tiers.strong } : {}),
      ...(org.models.tiers.cheap ? { cheap: org.models.tiers.cheap } : {}),
      ...(org.models.tiers.decision ? { decision: org.models.tiers.decision } : {}),
    },
    judge: org.models.gates.judge,
  };
}

function validate(patch: OrgConfigPatch): void {
  for (const [name, v] of Object.entries(patch.tiers ?? {})) {
    if (!(TIER_NAMES as string[]).includes(name))
      throw new Error(`unknown tier "${name}": use ${TIER_NAMES.join(', ')}`);
    if (v === undefined) continue;
    if (v === null) throw new Error(`tier ${name} cannot be cleared: pick another model`);
    if (!(isModelRef(v) || (name === 'decision' && isJev(v))))
      throw new Error(
        `tier ${name}: "${String(v)}" must look like provider/model (see /model for the list)${name === 'decision' ? ' or jev-latest' : ''}`,
      );
  }
  if (patch.judge !== undefined && patch.judge !== null && !isModelRef(patch.judge))
    throw new Error(`judge: "${String(patch.judge)}" must look like provider/model`);
  if (
    patch.adapter !== undefined &&
    patch.adapter !== null &&
    !(ADAPTERS as readonly string[]).includes(patch.adapter)
  )
    throw new Error(`adapter must be one of ${ADAPTERS.join(', ')}`);
  if (
    patch.per_run_usd !== undefined &&
    patch.per_run_usd !== null &&
    !(
      typeof patch.per_run_usd === 'number' &&
      Number.isFinite(patch.per_run_usd) &&
      patch.per_run_usd > 0
    )
  )
    throw new Error('budget (per_run_usd) must be a positive number');
}

type Doc = ReturnType<typeof parseDocument>;
/** A YAML file as a document (comments kept); an empty one when the file does not exist. */
export const readDoc = (path: string): Doc =>
  parseDocument(existsSync(path) ? readFileSync(path, 'utf8') : '');
const setOrDelete = (doc: Doc, path: string[], v: string | number | null | undefined) => {
  if (v === undefined) return;
  if (v === null) {
    if (doc.hasIn(path)) doc.deleteIn(path);
  } else doc.setIn(path, v);
};
/** The file is replaced in one step: a run loading the org never sees a half-written file. */
export const writeAtomic = (path: string, text: string) => {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
};

/**
 * Applies `patch` to `models.yaml` / `org.yaml`, keeping comments and every other key. The
 * patched documents are checked against the org schemas before anything touches the disk,
 * so a refused change never leaves the org unloadable.
 */
export function writeOrgConfig(root: string, patch: OrgConfigPatch): OrgConfig {
  validate(patch);
  loadOrg(root); // an org that does not load is not edited
  const writes: { path: string; text: string }[] = [];
  if (patch.tiers !== undefined || patch.judge !== undefined) {
    const path = join(root, 'models.yaml');
    const doc = readDoc(path);
    for (const [name, v] of Object.entries(patch.tiers ?? {})) setOrDelete(doc, ['tiers', name], v);
    setOrDelete(doc, ['gates', 'judge'], patch.judge);
    ModelsSchema.parse(doc.toJS() ?? {});
    writes.push({ path, text: doc.toString() });
  }
  if (patch.adapter !== undefined || patch.per_run_usd !== undefined) {
    const path = join(root, 'org.yaml');
    const doc = readDoc(path);
    setOrDelete(doc, ['adapter'], patch.adapter);
    setOrDelete(doc, ['budgets', 'per_run_usd'], patch.per_run_usd);
    OrgFileSchema.parse(doc.toJS() ?? {});
    writes.push({ path, text: doc.toString() });
  }
  for (const w of writes) writeAtomic(w.path, w.text);
  return readOrgConfig(root);
}
