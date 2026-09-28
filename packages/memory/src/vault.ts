import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { NodeState, RunState, StoredEvent } from '@wizardingcode/shibaox-core';
import type { GateReport, Workflow } from '@wizardingcode/shibaox-schemas';

export interface VaultLayout {
  root: string;
}

const VAULT_FOLDERS = ['00-org', '10-projects', '20-clients', '30-knowledge', '90-system'] as const;

/** Creates the vault's top-level folders when they are missing. */
export function ensureVault(root: string): void {
  for (const dir of VAULT_FOLDERS) mkdirSync(join(root, dir), { recursive: true });
}

const SAFE_ID_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Guards identifiers (project names, node ids) that are interpolated into a
 * vault-relative path: rejects anything outside `[A-Za-z0-9._-]` (which rules
 * out `/`, so no path segment can be smuggled in) and any value containing
 * `..` (so a value like `..` alone can't walk up a directory either).
 */
function assertSafeId(kind: string, value: string): void {
  if (!SAFE_ID_RE.test(value) || value.includes('..')) {
    throw new Error(`invalid ${kind} "${value}"`);
  }
}

function inside(root: string, p: string): boolean {
  const r = relative(root, p);
  return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r));
}

function lexists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves `rel` against `vault` and guarantees the result stays inside it:
 * rejects `../` escapes, absolute paths outside, and symlinks (on the deepest
 * existing ancestor, including dangling ones) that resolve outside.
 * Same boundary logic as `safePath` in `@wizardingcode/shibaox-adapter-direct`, adapted to
 * the vault's own error message. Returns the lexical path under `vault` (not
 * its realpath).
 */
export function safeVaultPath(vault: string, rel: string): string {
  const base = resolve(vault);
  const root = realpathSync(base);
  const target = resolve(base, rel);
  const escapes = () => new Error(`path "${rel}" escapes vault`);
  if (!inside(base, target)) throw escapes();
  let probe = target;
  while (!lexists(probe)) {
    const parent = dirname(probe);
    if (parent === probe) throw escapes();
    probe = parent;
  }
  let real: string;
  try {
    real = realpathSync(probe);
  } catch {
    throw escapes(); // dangling symlink: its destination cannot be verified
  }
  if (!inside(root, real)) throw escapes();
  return target;
}

/**
 * Builds `<relDir>/<base><ext>`, `<relDir>/<base>-2<ext>`, … under `vault`,
 * returning the first that doesn't already exist. Every candidate — including
 * the numbered suffixes — is routed through `safeVaultPath` so a boundary
 * escape can never slip through via a later suffix either.
 */
function uniqueSafePath(vault: string, relDir: string, base: string, ext: string): string {
  let rel = join(relDir, `${base}${ext}`);
  let candidate = safeVaultPath(vault, rel);
  for (let n = 2; existsSync(candidate); n++) {
    rel = join(relDir, `${base}-${n}${ext}`);
    candidate = safeVaultPath(vault, rel);
  }
  return candidate;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/**
 * Renders a frontmatter scalar: strings are JSON-quoted (which YAML's
 * double-quoted flow scalar syntax accepts) so a `: `, `"` or embedded
 * newline in a run/workflow/project name or summary can never break the
 * line-oriented frontmatter; numbers and booleans are written bare.
 */
function yamlScalar(value: string | number | boolean): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

function nodeCell(nodeType: string | undefined, ns: NodeState): string {
  if (nodeType === 'decide' && ns.choice) return `choice: ${ns.choice}`;
  if (ns.summary) return escapeCell(ns.summary);
  if (ns.error) return `error: ${escapeCell(ns.error)}`;
  return '';
}

function renderNodesTable(state: RunState, workflow: Workflow): string {
  const rows = Object.entries(state.nodes).map(([id, ns]) => {
    const nodeType = workflow.nodes[id]?.type;
    return `| ${id} | ${ns.status} | ${ns.attempts} | ${nodeCell(nodeType, ns)} |`;
  });
  return ['| id | status | attempts | summary/choice |', '| --- | --- | --- | --- |', ...rows].join(
    '\n',
  );
}

function renderGateReport(report: GateReport | undefined): string {
  if (!report) return '_no gate has run yet_';
  const rows = report.checks.map(
    (c) => `| ${c.name} | ${c.type} | ${c.passed} | ${c.skipped} | ${escapeCell(c.evidence)} |`,
  );
  return [
    `- gates: ${report.gates.join(', ')}`,
    `- passed: ${report.passed}`,
    '',
    '| check | type | passed | skipped | evidence |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

function eventLine(e: StoredEvent): string {
  return 'nodeId' in e ? `- ${e.at} ${e.type} ${e.nodeId}` : `- ${e.at} ${e.type}`;
}

function renderTimeline(events: StoredEvent[]): string {
  return events.map(eventLine).join('\n');
}

function taskRoles(workflow: Workflow): string[] {
  const roles = new Set<string>();
  for (const node of Object.values(workflow.nodes)) if (node.type === 'task') roles.add(node.role);
  return [...roles];
}

function renderLinks(project: string, workflow: Workflow): string {
  const roleLinks = taskRoles(workflow).map((r) => `- [[role-${r}]]`);
  return [`- [[${project}]]`, `- [[workflow-${workflow.workflow}]]`, ...roleLinks].join('\n');
}

/**
 * Writes `10-projects/<project>/runs/<YYYY-MM-DD>-<runId8>.md`: frontmatter
 * (`type: run`, run/workflow/status/adapter identifiers, `nodes` as a YAML
 * list) followed by Summary, Nodes, Last gate report, Timeline and Links
 * sections. Dates come from `events[0].at` (started) and the last event
 * (finished). Never overwrites an existing note; appends `-2`, `-3`, …
 */
export function writeRunNote(args: {
  vault: string;
  project: string;
  state: RunState;
  events: StoredEvent[];
  workflow: Workflow;
  adapter: string;
}): { path: string } {
  const { vault, project, state, events, workflow, adapter } = args;
  assertSafeId('project', project);
  ensureVault(vault);
  const startedAt = events[0]?.at ?? new Date().toISOString();
  const finishedAt = events.at(-1)?.at ?? startedAt;
  const date = startedAt.slice(0, 10);
  const runId8 = state.runId.slice(0, 8);
  const relDir = join('10-projects', project, 'runs');
  mkdirSync(safeVaultPath(vault, relDir), { recursive: true });
  const path = uniqueSafePath(vault, relDir, `${date}-${runId8}`, '.md');

  const frontmatter = [
    '---',
    'type: run',
    `run_id: ${yamlScalar(state.runId)}`,
    `project: ${yamlScalar(project)}`,
    `workflow: ${yamlScalar(workflow.workflow)}`,
    `status: ${yamlScalar(state.status)}`,
    `adapter: ${yamlScalar(adapter)}`,
    `spent_usd: ${yamlScalar(state.spentUsd)}`,
    `started_at: ${yamlScalar(startedAt)}`,
    `finished_at: ${yamlScalar(finishedAt)}`,
    'nodes:',
    ...Object.keys(state.nodes).map((id) => `  - ${yamlScalar(id)}`),
    '---',
    '',
  ].join('\n');

  const body = [
    '## Summary',
    '',
    `- status: ${state.status}`,
    `- adapter: ${adapter}`,
    `- spent_usd: ${state.spentUsd}`,
    `- started_at: ${startedAt}`,
    `- finished_at: ${finishedAt}`,
    '',
    '## Nodes',
    '',
    renderNodesTable(state, workflow),
    '',
    '## Last gate report',
    '',
    renderGateReport(state.lastGateReport),
    '',
    '## Timeline',
    '',
    renderTimeline(events),
    '',
    '## Links',
    '',
    renderLinks(project, workflow),
    '',
  ].join('\n');

  writeFileSync(path, `${frontmatter}\n${body}`, 'utf8');
  return { path };
}

/** The node's own last `DecisionMade`/`HumanResponded` event, when available. */
function lastDecisionAt(events: StoredEvent[] | undefined, nodeId: string): string | undefined {
  if (!events) return undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (
      e &&
      'nodeId' in e &&
      e.nodeId === nodeId &&
      (e.type === 'DecisionMade' || e.type === 'HumanResponded')
    )
      return e.at;
  }
  return undefined;
}

/**
 * Writes `90-system/decisions/<date>-<runId8>-<nodeId>.md` for a single
 * node's decision. `date` is deterministic, not wall-clock: it comes from
 * `at` when given, else from the node's own last `DecisionMade`/
 * `HumanResponded` event in `events` when given, else from `Date.now()` as a
 * last resort. This makes repeat calls for the same decision resolve to the
 * same base filename (so a second call is a genuine re-write, suffixed `-2`,
 * rather than landing on a different day's file).
 */
export function writeDecisionNote(args: {
  vault: string;
  project: string;
  state: RunState;
  nodeId: string;
  at?: string;
  events?: StoredEvent[];
}): { path: string } {
  const { vault, project, state, nodeId, events } = args;
  assertSafeId('project', project);
  assertSafeId('nodeId', nodeId);
  ensureVault(vault);
  const ns = state.nodes[nodeId];
  if (!ns) throw new Error(`node "${nodeId}" not found in run state`);
  const at = args.at ?? lastDecisionAt(events, nodeId) ?? new Date().toISOString();
  const date = at.slice(0, 10);
  const runId8 = state.runId.slice(0, 8);
  const relDir = join('90-system', 'decisions');
  mkdirSync(safeVaultPath(vault, relDir), { recursive: true });
  const path = uniqueSafePath(vault, relDir, `${date}-${runId8}-${nodeId}`, '.md');

  const frontmatter = [
    '---',
    'type: decision',
    `run_id: ${yamlScalar(state.runId)}`,
    `project: ${yamlScalar(project)}`,
    `node_id: ${yamlScalar(nodeId)}`,
    `status: ${yamlScalar(ns.status)}`,
    `choice: ${yamlScalar(ns.choice ?? '')}`,
    '---',
    '',
  ].join('\n');

  const body = [
    '## Decision',
    '',
    `- node: ${nodeId}`,
    `- status: ${ns.status}`,
    `- attempts: ${ns.attempts}`,
    `- choice: ${ns.choice ?? ''}`,
    ns.summary ? `- summary: ${ns.summary}` : '',
    '',
    '## Links',
    '',
    `- [[${project}]]`,
    '',
  ].join('\n');

  writeFileSync(path, `${frontmatter}\n${body}`, 'utf8');
  return { path };
}
