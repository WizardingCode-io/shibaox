import { ClaudeCodeAdapter, type McpServers, type QueryFn } from '@shibaox/adapter-claude-code';
import { DirectAdapter } from '@shibaox/adapter-direct';
import {
  type AgentTool,
  type ApprovalHandler,
  type CheckRunners,
  type Decider,
  defaultCheckRunners,
  type EventStore,
  type HumanHandler,
  MockAdapter,
  type MockScript,
  type ModelResolution,
  RunEngine,
  type RuntimeEvent,
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
import { diffRunWorkspace } from '@shibaox/workspace';

export const AVAILABLE_RUNTIMES = ['mock', 'direct', 'claude-code'];
export const ADAPTER_IDS = ['mock', 'direct', 'claude-code'] as const;
export type AdapterId = (typeof ADAPTER_IDS)[number];

export const isAdapterId = (v: unknown): v is AdapterId =>
  typeof v === 'string' && (ADAPTER_IDS as readonly string[]).includes(v);

/** `--adapter`, else `adapter:` in org.yaml, else `mock`. */
export const effectiveAdapter = (explicit: AdapterId | undefined, org: Org): AdapterId =>
  explicit ?? org.org.adapter ?? 'mock';

/** The registry of this environment (the built-in catalog plus extra entries). */
export const registryFor = (env: NodeJS.ProcessEnv, extra?: ProviderEntry[]): ProviderRegistry =>
  new ProviderRegistry([...loadCatalog(), ...(extra ?? [])], env);

/** The adapter a chosen model runs through: its provider's runtime, else the direct loop. */
export function adapterForModel(ref: string, registry: ProviderRegistry): AdapterId {
  const { provider } = registry.parseRef(ref);
  const entry = registry.list().find((e) => e.id === provider);
  if (!entry) throw new Error(`unknown provider "${provider}" in model ref "${ref}"`);
  if (entry.via_runtime === 'claude-code') return 'claude-code';
  if (entry.via_runtime)
    throw new Error(
      `provider "${provider}" needs runtime "${entry.via_runtime}", which is not available`,
    );
  return 'direct';
}

/** The project's knowledge graph, as wired into the adapters (see `prepareGraph` in run.ts). */
export interface GraphWiring {
  /** `graph_query` for the direct adapter. */
  query?: (question: string) => Promise<string>;
  /** MCP servers for the Claude Code adapter (already filtered by autorouting). */
  mcpServers?: McpServers;
}

export interface RuntimeOptions {
  org: Org;
  store: EventStore;
  human: HumanHandler;
  /** Push/deploy approvals for adapters; defaults to asking `human` (deferred → task fails). */
  approvals?: ApprovalHandler;
  log: (line: string) => void;
  /** Explicit adapter (`--adapter`); else `adapter:` in org.yaml; else `mock`. */
  adapter?: AdapterId;
  /** Workflow about to run/resume: with `direct`, its task roles are resolved up front. */
  workflow?: Workflow;
  /** Effective run budget; with `direct`, unpriced models produce a warning. */
  budgetUsd?: number;
  /** A model ref chosen for the run: every task role runs on it (adapter derived from it). */
  model?: string;
  env?: NodeJS.ProcessEnv;
  /** Providers added to the built-in catalog (tests, local overrides). */
  extraProviders?: ProviderEntry[];
  /** Root used to resolve role system prompts; defaults to the org root. */
  orgRoot?: string;
  /** The SDK `query` for the Claude Code adapter (tests inject a fake). */
  queryFn?: QueryFn;
  graph?: GraphWiring;
  /** Run id for `start` (the CLI picks it first to name the worktree). */
  newRunId?: () => string;
  /** What the mock adapter does per task (tests inject gates/delays). */
  mockScript?: MockScript;
  /** Every RuntimeEvent a task yields (the daemon streams them). */
  onRuntimeEvent?: (runId: string, nodeId: string, e: RuntimeEvent) => void;
  /** What the daemon adds to every task: extra tools by role and a prompt preamble. */
  tools?: {
    extra?: (job: TaskJob) => AgentTool[];
    preamble?: (job: TaskJob) => string | undefined;
  };
}

/** Bridges a HumanHandler to the approval interface (the CLI's terminal prompt). */
export function humanApprovals(human: HumanHandler): ApprovalHandler {
  return {
    request: async (req) => {
      const a = await human.ask({
        runId: req.runId,
        nodeId: req.nodeId,
        action: `approve-${req.category}`,
        prompt: `Bash: ${req.command}`,
      });
      return 'deferred' in a ? { deferred: true, approvalId: 'terminal' } : a;
    },
  };
}

const mockAdapter = (script?: MockScript) =>
  new MockAdapter(
    script ??
      ((j) => ({
        output: { instruction: j.instruction },
        summary: `mock ${j.role.role}: ${j.instruction}`,
        cost: { usd: 0.001, inputTokens: 10, outputTokens: 10 },
      })),
  );

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
 * every task role of the workflow must resolve to a usable model; with
 * `claude-code`, each role runs where the org's routing sends it (Claude Code
 * for `anthropic-subscription/...` and roles preferring it, else direct) and
 * must resolve there. A role that cannot throws `cannot start: ...` before any
 * event is written.
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
  const adapter: AdapterId = effectiveAdapter(o.adapter, o.org);
  const direct = adapter === 'direct';
  const real = adapter !== 'mock';

  /**
   * How a role runs. With `direct` every role must resolve to a direct model; with
   * `claude-code` the org's routing decides per role (`anthropic-subscription/...` and
   * roles preferring claude-code run there, the rest run direct).
   */
  const resolveRole = (role: Role, warn: (w: string) => void): ModelResolution => {
    if (o.model) {
      // one model for the whole run: the choice made in the dashboard or on the command line
      const { provider, model } = registry.parseRef(o.model);
      const entry = registry.list().find((e) => e.id === provider);
      if (!entry) throw new Error(`unknown provider "${provider}" in model ref "${o.model}"`);
      if (entry.via_runtime)
        return { kind: 'runtime', runtime: entry.via_runtime, model, ref: o.model };
      const c = registry.isConfigured(provider);
      if (!c.ok)
        throw new Error(
          `provider "${provider}" is not configured (missing ${c.missing.join(', ')})`,
        );
      return { kind: 'direct', ref: o.model, provider, model };
    }
    const r = resolveModel({
      role,
      models: o.org.models,
      providers: routerProviders,
      runtimes: AVAILABLE_RUNTIMES,
      defaultAdapter: direct ? 'direct' : undefined,
    });
    for (const w of r.warnings) warn(w);
    if (r.resolution.kind === 'runtime' && (direct || r.resolution.runtime !== 'claude-code'))
      throw new Error(
        `role ${role.role} resolved to runtime ${r.resolution.runtime}, which is not available${direct ? ' with --adapter direct' : ''}`,
      );
    return r.resolution;
  };
  const resolveRoleRef = (role: Role, warn: (w: string) => void): string => {
    const r = resolveRole(role, warn);
    if (r.kind !== 'direct') throw new Error(`role ${role.role} does not run on a direct model`);
    return r.ref;
  };
  const resolveRef = (job: TaskJob): string => resolveRoleRef(job.role, (w) => o.log(`warn: ${w}`));
  const adapterFor = (job: TaskJob): string => {
    if (adapter !== 'claude-code') return adapter;
    return resolveRole(job.role, () => {}).kind === 'runtime' ? 'claude-code' : 'direct';
  };

  o.log(`adapter=${adapter}`);
  const usedRefs = new Set<string>();
  if (real && o.workflow) {
    const roles = new Set<string>();
    for (const node of Object.values(o.workflow.nodes))
      if (node.type === 'task') roles.add(node.role);
    for (const name of roles) {
      let target: string;
      try {
        const role = o.org.roles[name];
        if (!role) throw new Error(`role "${name}" is not defined`);
        const r = resolveRole(role, () => {});
        if (r.kind === 'direct') {
          registry.model(r.ref);
          usedRefs.add(r.ref);
          target = r.ref;
        } else target = `claude-code${r.model ? ` (${r.model})` : ''}`;
      } catch (err) {
        throw new Error(
          `cannot start: role "${name}" → ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      o.log(`  ${name} → ${target}`);
    }
  }

  const strongRef = o.org.models.tiers.strong;
  const strongOk = real && strongRef !== undefined && unusable(registry, strongRef) === undefined;

  const jevKey = env.TYPESAFE_API_KEY;
  const jev = jevKey
    ? new JevClient({ apiKey: jevKey, baseURL: env.SHIBAOX_JEV_BASE_URL || undefined })
    : undefined;
  const judgeRef = o.org.models.gates.judge ?? strongRef;
  const judge =
    real && judgeRef && unusable(registry, judgeRef) === undefined
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
      real
        ? `no usable judge model (${judgeRef ?? 'unset'}): judge checks will fail`
        : 'judge checks need a real adapter: they will fail with the mock adapter',
    );
  const lead: Decider | undefined =
    strongOk && strongRef ? new LeadDecider(llm, strongRef) : undefined;
  if (lead && strongRef) usedRefs.add(strongRef);
  const decider: Decider = jev
    ? new JevDecider(jev, { threshold: 0.8, fallback: lead })
    : (lead ?? new ScriptedDecider({}, 'ship'));
  if (!jev && !lead) warnings.push('no decider model configured: decide nodes always pick "ship"');

  if (real && o.budgetUsd !== undefined)
    for (const ref of usedRefs)
      if (registry.estimateCost(ref, { inputTokens: 1, outputTokens: 1 }) === undefined)
        warnings.push(`model "${ref}" has no pricing: budget cannot be enforced for it`);

  const orgRoot = o.orgRoot ?? o.org.root;
  const approvals: ApprovalHandler = o.approvals ?? humanApprovals(o.human);
  const engine = new RunEngine({
    store: o.store,
    org: o.org,
    adapters: {
      mock: mockAdapter(o.mockScript),
      direct: new DirectAdapter({
        registry,
        resolveRef,
        orgRoot,
        graphQuery: o.graph?.query,
        approvals,
        extraTools: o.tools?.extra,
        preamble: o.tools?.preamble,
      }),
      'claude-code': new ClaudeCodeAdapter({
        approvals,
        orgRoot,
        model: (job) => {
          const r = resolveRole(job.role, () => {});
          return r.kind === 'runtime' ? r.model : undefined;
        },
        // subscription roles run on the `claude` login: the API key is not handed over
        modelRef: (job) => {
          const r = resolveRole(job.role, () => {});
          return r.kind === 'runtime' ? r.ref : undefined;
        },
        mcpServers: () => ({ ...o.graph?.mcpServers }),
        queryFn: o.queryFn,
        extraTools: o.tools?.extra,
        preamble: o.tools?.preamble,
      }),
    },
    defaultAdapter: adapter,
    adapterFor,
    diffProvider: diffRunWorkspace,
    newRunId: o.newRunId,
    approvals,
    onRuntimeEvent: o.onRuntimeEvent,
    decider,
    human: o.human,
    checkRunners,
    log: o.log,
  });
  return { engine, warnings, registry, adapter };
}
