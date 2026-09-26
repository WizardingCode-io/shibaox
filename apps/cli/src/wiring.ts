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
import type { Org } from '@shibaox/schemas';
import { AVAILABLE_RUNTIMES } from './commands/models.js';

export type AdapterId = 'mock' | 'direct';

export interface RuntimeOptions {
  org: Org;
  store: EventStore;
  human: HumanHandler;
  log: (line: string) => void;
  /** Explicit adapter; when omitted, `direct` if the `strong` tier is usable, else `mock`. */
  adapter?: AdapterId;
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

  const strongRef = o.org.models.tiers.strong;
  const strongProblem = unusable(registry, strongRef);
  const strongOk = strongRef !== undefined && strongProblem === undefined;
  const adapter: AdapterId = o.adapter ?? (strongOk ? 'direct' : 'mock');
  if (!o.adapter && adapter === 'mock')
    warnings.push(
      `no usable model for tier "strong" (${strongRef ?? 'unset'}: ${strongProblem}); using the mock adapter (set models.yaml and provider keys)`,
    );
  else if (adapter === 'direct' && !strongOk)
    warnings.push(`tier "strong" (${strongRef ?? 'unset'}) is not usable: ${strongProblem}`);

  const resolveRef = (job: TaskJob): string => {
    const r = resolveModel({
      role: job.role,
      models: o.org.models,
      providers: routerProviders,
      runtimes: AVAILABLE_RUNTIMES,
      defaultAdapter: 'direct',
    });
    for (const w of r.warnings) o.log(`warn: ${w}`);
    if (r.resolution.kind !== 'direct')
      throw new Error(
        `role ${job.role.role} resolved to runtime ${r.resolution.runtime}, not available in phase 1B-1`,
      );
    return r.resolution.ref;
  };

  const jevKey = env.TYPESAFE_API_KEY;
  const jev = jevKey
    ? new JevClient({ apiKey: jevKey, baseURL: env.SHIBAOX_JEV_BASE_URL || undefined })
    : undefined;
  const judgeRef = o.org.models.gates.judge ?? strongRef;
  const judge =
    judgeRef && unusable(registry, judgeRef) === undefined
      ? judgeCheckRunner(llm, judgeRef)
      : undefined;
  const checkRunners: CheckRunners = {
    ...defaultCheckRunners(),
    ...(judge ? { judge } : {}),
    ...(jev ? { jev: jevCheckRunner(jev, { escalate: judge }) } : {}),
  };
  const usesJev = Object.values(o.org.gates).some((g) => g.checks.some((c) => c.type === 'jev'));
  if (!jev && usesJev) warnings.push('TYPESAFE_API_KEY not set: jev checks will fail');
  const lead: Decider | undefined =
    strongOk && strongRef ? new LeadDecider(llm, strongRef) : undefined;
  const decider: Decider = jev
    ? new JevDecider(jev, { threshold: 0.8, fallback: lead })
    : (lead ?? new ScriptedDecider({}, 'ship'));
  if (!jev && !lead) warnings.push('no decider model configured: decide nodes always pick "ship"');

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
