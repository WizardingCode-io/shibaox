import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadOrg } from '@shibaox/schemas';
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

/** Values to change; `null` clears one. */
export interface OrgConfigPatch {
  tiers?: Partial<Record<TierName, string | null>>;
  judge?: string | null;
  adapter?: OrgConfig['adapter'] | null;
  per_run_usd?: number | null;
}

/** A model ref (`provider/model`) or a Jev alias (`jev-latest`). */
const isModelValue = (v: string) =>
  /^[a-z0-9][a-z0-9-]*\/\S+$/i.test(v) || /^jev-[\w.-]+$/i.test(v);

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
  for (const [name, v] of Object.entries(patch.tiers ?? {}))
    if (v !== null && v !== undefined && !isModelValue(v))
      throw new Error(
        `tier ${name}: "${v}" must look like provider/model (see /model for the list)`,
      );
  if (patch.judge && !isModelValue(patch.judge))
    throw new Error(`judge: "${patch.judge}" must look like provider/model`);
  if (patch.adapter && !ADAPTERS.includes(patch.adapter))
    throw new Error(`adapter must be one of ${ADAPTERS.join(', ')}`);
  if (patch.per_run_usd !== undefined && patch.per_run_usd !== null && !(patch.per_run_usd > 0))
    throw new Error('budget (per_run_usd) must be a positive number');
}

function rewrite(path: string, edit: (doc: ReturnType<typeof parseDocument>) => void): void {
  const doc = parseDocument(existsSync(path) ? readFileSync(path, 'utf8') : '{}');
  edit(doc);
  writeFileSync(path, doc.toString());
}

/** Applies `patch` to `models.yaml` / `org.yaml`, keeping comments and every other key. */
export function writeOrgConfig(root: string, patch: OrgConfigPatch): OrgConfig {
  validate(patch);
  loadOrg(root); // an org that does not load is not edited
  const hasModelsChange = patch.tiers !== undefined || patch.judge !== undefined;
  if (hasModelsChange)
    rewrite(join(root, 'models.yaml'), (doc) => {
      for (const [name, v] of Object.entries(patch.tiers ?? {})) {
        if (v === null) doc.deleteIn(['tiers', name]);
        else if (v !== undefined) doc.setIn(['tiers', name], v);
      }
      if (patch.judge === null) doc.deleteIn(['gates', 'judge']);
      else if (patch.judge !== undefined) doc.setIn(['gates', 'judge'], patch.judge);
    });
  if (patch.adapter !== undefined || patch.per_run_usd !== undefined)
    rewrite(join(root, 'org.yaml'), (doc) => {
      if (patch.adapter === null) doc.deleteIn(['adapter']);
      else if (patch.adapter !== undefined) doc.setIn(['adapter'], patch.adapter);
      if (patch.per_run_usd === null) doc.deleteIn(['budgets', 'per_run_usd']);
      else if (patch.per_run_usd !== undefined)
        doc.setIn(['budgets', 'per_run_usd'], patch.per_run_usd);
    });
  return readOrgConfig(root);
}
