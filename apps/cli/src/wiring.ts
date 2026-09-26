import { DirectAdapter } from '@shibaox/adapter-direct';
import {
  type CheckRunners,
  type Decider,
  defaultCheckRunners,
  type EventStore,
  type HumanHandler,
  MockAdapter,
  RunEngine,
  resolveModel,
  ScriptedDecider,
  type TaskJob,
} from '@shibaox/core';
import { JevClient, JevDecider, jevCheckRunner } from '@shibaox/jev';
import {
  judgeCheckRunner,
  LeadDecider,
  LlmClient,
  loadCatalog,
  type ProviderEntry,
  ProviderRegistry,
} from '@shibaox/providers';
import type { Org, Role, Workflow } from '@shibaox/schemas';
import { AVAILABLE_RUNTIMES } from './commands/models.js';

export type AdapterId = 'mock' | 'direct';

export interface RuntimeOptions {
  org: Org;
  store: EventStore;
  human: HumanHandler;
  log: (line: string) => void;
  /** Explicit adapter (`--adapter`); else `adapter:` in org.yaml; else `mock`. */
  adapter?: AdapterId;
  /** Workflow about to run/resume: with `direct`, its task roles are resolved up front. */
  workflow?: Workflow;
  /** Effective run budget; with `direct`, unpriced models produce a warning. */
  budgetUsd?: number;
  env?: NodeJS.ProcessEnv;
  /** Providers added to the built-in catalog (tests, local overrides). */
  extraProviders?: ProviderEntry[];
  /** Root used to resolve role system prompts; defaults to the org root. */
  orgRoot?: string;
}

const mockAdapter = () =>
  new MockAdapter((j) => ({
    output: { instruction: j.instruction },
    summary: `mock ${j.role.role}: ${j.instruction}`,
    cost: { usd: 0.001, inputTokens: 10, outputTokens: 10 },
  }));

/** `undefined` when `ref` is a usable direct model, else why it is not. */
function unusable(registry: ProviderRegistry, ref: string | undefined): string | undefined {
  if (!ref) return 'not set';
  try {
    registry.model(ref);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * The single place that assembles adapters, check runners and the decider for
 * `run` and `resume`, from the org's models.yaml and the environment.
 *
 * The adapter is `--adapter`, else `adapter:` in org.yaml, else `mock`; it is
 * never picked silently from the keys in the environment. With `mock`, no
 * provider model is called (no LLM judge, no lead decider). With `direct`,
 * every task role of the workflow must resolve to a usable model or this
 * throws `cannot start: ...` before any event is written.
 */
export function buildRuntime(o: RuntimeOptions) {
  const env = o.env ?? process.env;
  const registry = new ProviderRegistry([...loadCatalog(), ...(o.extraProviders ?? [])], env);
  const routerProviders = registry.list().map((e) => ({
    id: e.id,
    via_runtime: e.via_runtime,
    configured: registry.isConfigured(e.id).ok,
  }));
  const warnings: string[] = [];
  const llm = new LlmClient(registry);
  const adapter: AdapterId = o.adapter ?? o.org.org.adapter ?? 'mock';
  const direct = adapter === 'direct';

  const resolveRoleRef = (role: Role, warn: (w: string) => void): string => {
    const r = resolveModel({
      role,
      models: o.org.models,
      providers: routerProviders,
      runtimes: AVAILABLE_RUNTIMES,
      defaultAdapter: 'direct',
    });
    for (const w of r.warnings) warn(w);
    if (r.resolution.kind !== 'direct')
      throw new Error(
        `role ${role.role} resolved to runtime ${r.resolution.runtime}, not available in phase 1B-1`,
      );
    return r.resolution.ref;
  };
  const resolveRef = (job: TaskJob): string => resolveRoleRef(job.role, (w) => o.log(`warn: ${w}`));

  o.log(`adapter=${adapter}`);
  const usedRefs = new Set<string>();
  if (direct && o.workflow) {
    const roles = new Set<string>();
    for (const node of Object.values(o.workflow.nodes))
      if (node.type === 'task') roles.add(node.role);
    for (const name of roles) {
      let ref: string;
      try {
        const role = o.org.roles[name];
        if (!role) throw new Error(`role "${name}" is not defined`);
        ref = resolveRoleRef(role, () => {});
        registry.model(ref);
      } catch (err) {
        throw new Error(
          `cannot start: role "${name}" → ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      usedRefs.add(ref);
      o.log(`  ${name} → ${ref}`);
    }
  }

  const strongRef = o.org.models.tiers.strong;
  const strongOk = direct && strongRef !== undefined && unusable(registry, strongRef) === undefined;

  const jevKey = env.TYPESAFE_API_KEY;
  const jev = jevKey
    ? new JevClient({ apiKey: jevKey, baseURL: env.SHIBAOX_JEV_BASE_URL || undefined })
    : undefined;
  const judgeRef = o.org.models.gates.judge ?? strongRef;
  const judge =
    direct && judgeRef && unusable(registry, judgeRef) === undefined
      ? judgeCheckRunner(llm, judgeRef)
      : undefined;
  if (judge && judgeRef) usedRefs.add(judgeRef);
  const checkRunners: CheckRunners = {
    ...defaultCheckRunners(),
    ...(judge ? { judge } : {}),
    ...(jev ? { jev: jevCheckRunner(jev, { escalate: judge }) } : {}),
  };
  const usesJev = Object.values(o.org.gates).some((g) => g.checks.some((c) => c.type === 'jev'));
  if (!jev && usesJev) warnings.push('TYPESAFE_API_KEY not set: jev checks will fail');
  const usesJudge = Object.values(o.org.gates).some((g) =>
    g.checks.some((c) => c.type === 'judge'),
  );
  if (!judge && usesJudge)
    warnings.push(
      direct
        ? `no usable judge model (${judgeRef ?? 'unset'}): judge checks will fail`
        : 'judge checks need the direct adapter: they will fail with the mock adapter',
    );
  const lead: Decider | undefined =
    strongOk && strongRef ? new LeadDecider(llm, strongRef) : undefined;
  if (lead && strongRef) usedRefs.add(strongRef);
  const decider: Decider = jev
    ? new JevDecider(jev, { threshold: 0.8, fallback: lead })
    : (lead ?? new ScriptedDecider({}, 'ship'));
  if (!jev && !lead) warnings.push('no decider model configured: decide nodes always pick "ship"');

  if (direct && o.budgetUsd !== undefined)
    for (const ref of usedRefs)
      if (registry.estimateCost(ref, { inputTokens: 1, outputTokens: 1 }) === undefined)
        warnings.push(`model "${ref}" has no pricing: budget cannot be enforced for it`);

  const engine = new RunEngine({
    store: o.store,
    org: o.org,
    adapters: {
      mock: mockAdapter(),
      direct: new DirectAdapter({ registry, resolveRef, orgRoot: o.orgRoot ?? o.org.root }),
    },
    defaultAdapter: adapter,
    decider,
    human: o.human,
    checkRunners,
    log: o.log,
  });
  return { engine, warnings, registry, adapter };
}
