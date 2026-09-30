import { randomUUID } from 'node:crypto';
import type { Org, RunEvent, Workflow, WorkflowNode } from '@wizardingcode/shibaox-schemas';
import type { EventStore, RunSummary } from '../events/store.js';
import { runCommand } from '../executors/code.js';
import { type DescribeRequest, runGitNode } from '../executors/git.js';
import {
  AdapterError,
  collectRun,
  type RuntimeAdapter,
  type RuntimeEvent,
  type TaskJob,
} from '../executors/types.js';
import { pullRequestRef } from '../gates/ci.js';
import { SETUP_TIMEOUT_MS } from '../gates/detect.js';
import { type CheckRunners, defaultCheckRunners, runGate } from '../gates/engine.js';
import { injectTeamGates } from '../org/inject-gates.js';
import { withSetup } from '../org/with-setup.js';
import type { ApprovalHandler } from './approvals.js';
import type { Decider, HumanHandler } from './deciders.js';
import type { MergeQueue } from './merge-queue.js';
import { isTerminal, replay } from './reducer.js';
import { isStalled, readyNodes } from './scheduler.js';
import type { NodeState, PendingApproval, RunState } from './state.js';
import { validateJson } from './validate-json.js';

export interface EngineDeps {
  store: EventStore;
  org: Org;
  adapters: Record<string, RuntimeAdapter>;
  defaultAdapter?: string;
  /**
   * Picks the adapter id for a `task` node's job when present, overriding
   * `defaultAdapter ?? role.runtime`. An id absent from `adapters` fails the
   * node with the same "no adapter registered" error as the default path.
   */
  adapterFor?: (job: TaskJob) => string;
  /**
   * Produces the workspace diff for `CheckContext.diff` in gate checks. A
   * rejecting provider degrades to an empty diff (logged as
   * `diff unavailable: <message>`) rather than failing the check/gate.
   */
  diffProvider?: (workspace: string) => Promise<string>;
  decider: Decider;
  human: HumanHandler;
  /**
   * Answers push/deploy approvals asked by adapters. The engine does not call it itself; it
   * is here so one wiring hands the same handler to every adapter.
   */
  approvals?: ApprovalHandler;
  /** Every RuntimeEvent a task adapter yields, for streaming (never persisted here). */
  onRuntimeEvent?: (runId: string, nodeId: string, e: RuntimeEvent) => void;
  /**
   * The environment of `code` nodes, gate commands and `git` nodes (the daemon's, vault keys
   * included, so `gh` finds its token); absent, the process environment alone.
   */
  env?: Record<string, string>;
  checkRunners?: CheckRunners;
  /** Writes commit messages and PR bodies for `git` nodes (absent: deterministic text). */
  describeChange?: (r: DescribeRequest) => Promise<string>;
  /** Merges of `git` nodes go through this queue, one project at a time. */
  mergeQueue?: MergeQueue;
  log?: (line: string) => void;
  now?: () => string;
  maxSteps?: number;
  newRunId?: () => string;
  scheduler?: { readyNodes: typeof readyNodes; isStalled: typeof isStalled };
}

export interface StartOptions {
  workflow: string;
  input: Record<string, unknown>;
  workspace: string;
  budgetUsd?: number;
  adapter?: string;
  workspaceMode?: 'inplace' | 'worktree';
  project?: string;
  branch?: string;
  baseBranch?: string;
  orgRoot?: string;
  parentRunId?: string;
  origin?: string;
  model?: string;
  /** A dependency install to run first (a fresh worktree): becomes a `setup` node in the snapshot. */
  setup?: { command: string; timeoutMs?: number };
}

export class RunEngine {
  private readonly log: (line: string) => void;
  private readonly now: () => string;
  private readonly maxSteps: number;
  private readonly checkRunners: CheckRunners;
  private readonly scheduler: { readyNodes: typeof readyNodes; isStalled: typeof isStalled };
  private readonly controllers = new Map<string, AbortController>();
  /** One controller per running task, so a steer stops that task and nothing else. */
  private readonly nodeControllers = new Map<string, AbortController>();
  /** Tasks stopped by a steer: whatever their adapter throws on abort is not a failure. */
  private readonly steered = new Set<string>();

  constructor(private readonly deps: EngineDeps) {
    this.log = deps.log ?? (() => {});
    this.now = deps.now ?? (() => new Date().toISOString());
    this.maxSteps = deps.maxSteps ?? 200;
    this.checkRunners = deps.checkRunners ?? defaultCheckRunners();
    this.scheduler = deps.scheduler ?? { readyNodes, isStalled };
  }

  /** Emits `RunCreated`; the run is `queued` until `run()`. */
  async create(opts: StartOptions): Promise<string> {
    const resolved = this.resolveFromOrg(opts.workflow);
    const workflowSnapshot = opts.setup
      ? withSetup(resolved, opts.setup.command, opts.setup.timeoutMs ?? SETUP_TIMEOUT_MS)
      : resolved;
    const runId = (this.deps.newRunId ?? randomUUID)();
    await this.emit({
      type: 'RunCreated',
      runId,
      at: this.now(),
      workflow: opts.workflow,
      input: opts.input,
      workspace: opts.workspace,
      budgetUsd: opts.budgetUsd,
      workflowSnapshot,
      adapter: opts.adapter,
      workspaceMode: opts.workspaceMode,
      project: opts.project,
      branch: opts.branch,
      baseBranch: opts.baseBranch,
      orgRoot: opts.orgRoot,
      parentRunId: opts.parentRunId,
      origin: opts.origin,
      model: opts.model,
    });
    return runId;
  }

  /**
   * Starts a `queued` run (emits `RunStarted`) or continues a `running` one left by a crash;
   * any other status is returned untouched.
   */
  async run(runId: string): Promise<RunState> {
    const state = await this.state(runId);
    if (state.status === 'queued') {
      await this.emit({ type: 'RunStarted', runId, at: this.now() });
      return this.drive(runId);
    }
    if (state.status === 'running') return this.drive(runId, { interrupted: true });
    return state;
  }

  async start(opts: StartOptions): Promise<RunState> {
    return this.run(await this.create(opts));
  }

  /**
   * For a run waiting on a tool approval whose task process is gone (daemon restart): every
   * `running` node becomes re-runnable, keeping its session id for resume.
   */
  async suspend(runId: string): Promise<RunState> {
    const state = await this.state(runId);
    const first = state.pendingApprovals[0]?.approvalId;
    if (state.status !== 'waiting_approval' || !first) return state;
    for (const [nodeId, n] of Object.entries(state.nodes))
      if (n.status === 'running')
        await this.emit({
          type: 'NodeSuspended',
          runId,
          nodeId,
          at: this.now(),
          sessionId: n.sessionId,
          approvalId: state.pendingApprovals.find((p) => p.nodeId === nodeId)?.approvalId ?? first,
        });
    return this.state(runId);
  }

  async state(runId: string): Promise<RunState> {
    const events = await this.deps.store.read(runId);
    if (events.length === 0) throw new Error(`run ${runId} not found`);
    return replay(events);
  }

  /**
   * Records a human answer for a pending human node and continues the run.
   * `nodeId` may be omitted only when exactly one human is pending.
   */
  async respond(
    runId: string,
    answer: { approved: boolean; note?: string },
    nodeId?: string,
  ): Promise<RunState> {
    const state = await this.state(runId);
    if (state.status !== 'waiting_human' || state.pendingHumans.length === 0)
      throw new Error(`run ${runId} is not waiting for a human`);
    const pendingIds = state.pendingHumans.map((p) => p.nodeId);
    let target: string;
    if (nodeId === undefined) {
      if (pendingIds.length !== 1)
        throw new Error(
          `run ${runId} is waiting on ${pendingIds.length} humans (${pendingIds.join(', ')}): pass a nodeId`,
        );
      target = pendingIds[0] as string;
    } else {
      if (!pendingIds.includes(nodeId))
        throw new Error(
          `run ${runId} is not waiting for a human at ${nodeId} (pending: ${pendingIds.join(', ')})`,
        );
      target = nodeId;
    }
    await this.recordHuman(runId, target, answer);
    return this.drive(runId);
  }

  async resume(runId: string, opts: { budgetUsd?: number } = {}): Promise<RunState> {
    const state = await this.state(runId);
    {
      const p = state.pendingApprovals[0] as PendingApproval | undefined;
      if (p)
        throw new Error(
          `run ${runId} is waiting for an approval: answer the pending approval first (shibaox approve approval:${p.approvalId})`,
        );
    }
    if (state.status === 'queued') return this.run(runId);
    if (state.status === 'paused_budget') {
      if (opts.budgetUsd === undefined || !(opts.budgetUsd > state.spentUsd))
        throw new Error(
          `run ${runId} is paused on budget: pass a budgetUsd higher than ${state.spentUsd}`,
        );
      await this.emit({ type: 'RunResumed', runId, at: this.now(), budgetUsd: opts.budgetUsd });
    } else if (state.status === 'waiting_human') {
      if (opts.budgetUsd !== undefined) {
        await this.emit({ type: 'RunResumed', runId, at: this.now(), budgetUsd: opts.budgetUsd });
      }
      for (const pending of state.pendingHumans) {
        const answer = await this.deps.human.ask({ runId, ...pending });
        if ('deferred' in answer) break;
        await this.recordHuman(runId, pending.nodeId, answer);
        if (!answer.approved) break;
      }
    } else if (state.status !== 'running') {
      return state;
    }
    return this.drive(runId, { interrupted: true });
  }

  async cancel(runId: string, reason: string): Promise<RunState> {
    const state = await this.state(runId);
    if (isTerminal(state.status)) return state;
    // Record the cancellation before aborting: the reducer keeps terminal
    // status sticky, so RunCancelled must be durably appended first or a
    // NodeFailed racing in from the aborted task could land first and win.
    await this.emit({ type: 'RunCancelled', runId, at: this.now(), reason });
    this.controllerFor(runId).abort(new Error(reason));
    this.releaseController(runId);
    return this.state(runId);
  }

  /**
   * Redirects a running task: records `NodeSteered`, stops that task alone, and the run
   * re-runs it with the note (and its runtime session when it has one). Without a nodeId the
   * one running task is steered; with several running, the node must be named.
   */
  async steer(
    runId: string,
    o: { nodeId?: string; note: string; via: 'cli' | 'telegram' | 'api' | 'orchestrator' },
  ): Promise<RunState> {
    const state = await this.state(runId);
    if (isTerminal(state.status))
      throw new Error(`run ${runId} is ${state.status}: nothing to steer`);
    const running = Object.entries(state.nodes)
      .filter(([, n]) => n.status === 'running')
      .map(([id]) => id);
    const nodeId = o.nodeId ?? (running.length === 1 ? running[0] : undefined);
    if (!nodeId)
      throw new Error(
        running.length === 0
          ? `run ${runId}: no task is running (status ${state.status})`
          : `run ${runId}: ${running.length} tasks are running, name one: ${running.join(', ')}`,
      );
    if (!running.includes(nodeId)) throw new Error(`run ${runId}: node ${nodeId} is not running`);
    if (!o.note.trim()) throw new Error('the steering note is empty');
    await this.emit({
      type: 'NodeSteered',
      runId,
      nodeId,
      at: this.now(),
      note: o.note.trim(),
      via: o.via,
    });
    const key = `${runId}:${nodeId}`;
    this.steered.add(key);
    this.nodeControllers.get(key)?.abort(new SteerSignal(nodeId, o.note.trim()));
    return this.state(runId);
  }

  /** Aborts a run's tasks without recording anything (the log stays as it is). */
  abort(runId: string, reason: string): void {
    this.controllerFor(runId).abort(new Error(reason));
    this.releaseController(runId);
  }

  async listRuns(): Promise<RunSummary[]> {
    return this.deps.store.listRuns();
  }

  /** Number of runs with a live AbortController (test/observability helper). */
  controllerCount(): number {
    return this.controllers.size;
  }

  /** Streams the event and records a `session` as `SessionStarted` (awaited before the node ends). */
  private onRuntimeEvent(
    runId: string,
    nodeId: string,
    e: RuntimeEvent,
    pendingEmits: Promise<void>[],
  ): void {
    this.deps.onRuntimeEvent?.(runId, nodeId, e);
    if (e.type === 'session')
      pendingEmits.push(
        this.emit({
          type: 'SessionStarted',
          runId,
          nodeId,
          at: this.now(),
          runtime: e.runtime,
          sessionId: e.sessionId,
        }),
      );
  }

  /** A task's own signal: aborted by a steer of that task, or by the run's cancellation. */
  private nodeSignal(runId: string, nodeId: string): AbortSignal {
    const key = `${runId}:${nodeId}`;
    const c = new AbortController();
    this.nodeControllers.set(key, c);
    const run = this.controllerFor(runId).signal;
    if (run.aborted) c.abort(run.reason);
    else run.addEventListener('abort', () => c.abort(run.reason), { once: true });
    return c.signal;
  }

  private controllerFor(runId: string): AbortController {
    let c = this.controllers.get(runId);
    if (!c) {
      c = new AbortController();
      this.controllers.set(runId, c);
    }
    return c;
  }

  private releaseController(runId: string): void {
    this.controllers.delete(runId);
  }

  private resolveFromOrg(name: string): Workflow {
    const wf = this.deps.org.workflows[name];
    if (!wf) throw new Error(`workflow "${name}" is not defined in the org`);
    const team = wf.team ? this.deps.org.teams[wf.team] : undefined;
    return team ? injectTeamGates(wf, team) : wf;
  }

  /**
   * Prefers the workflow snapshot recorded at `RunCreated` so a resumed run
   * keeps executing the workflow it started with, even if the org's files
   * changed since. Falls back to a fresh org lookup for older event logs
   * recorded before snapshots existed.
   */
  private resolveWorkflow(state: RunState): Workflow {
    return state.workflowSnapshot ?? this.resolveFromOrg(state.workflow);
  }

  private async emit(event: RunEvent): Promise<void> {
    await this.deps.store.append(event);
    this.log(
      `[${event.runId.slice(0, 8)}] ${event.type}${'nodeId' in event ? ` ${event.nodeId}` : ''}`,
    );
  }

  private async recordHuman(
    runId: string,
    nodeId: string,
    answer: { approved: boolean; note?: string; via?: 'cli' | 'telegram' | 'api' | 'auto' },
  ): Promise<void> {
    await this.emit({
      type: 'HumanResponded',
      runId,
      nodeId,
      at: this.now(),
      approved: answer.approved,
      note: answer.note,
      via: answer.via,
    });
    // A rejection needs no extra event: the reducer derives `cancelled`.
  }

  private async drive(runId: string, opts: { interrupted?: boolean } = {}): Promise<RunState> {
    let interrupted = opts.interrupted ?? false;
    for (let steps = 0; ; steps++) {
      let state = await this.state(runId);
      if (interrupted) {
        state = markInterrupted(state);
        interrupted = false;
      }
      if (state.status !== 'running') {
        if (isTerminal(state.status)) this.releaseController(runId);
        return state;
      }
      if (this.controllerFor(runId).signal.aborted) {
        this.releaseController(runId);
        return state;
      }
      const workflow = this.resolveWorkflow(state);
      const ready = this.scheduler.readyNodes(state, workflow);
      if (ready.length === 0) {
        const stall = this.scheduler.isStalled(state, workflow);
        if (stall.stalled) {
          await this.emit({
            type: 'RunCancelled',
            runId,
            at: this.now(),
            reason: `stalled: ${stall.reason}`,
          });
        } else {
          await this.emit({ type: 'RunCompleted', runId, at: this.now() });
        }
        this.releaseController(runId);
        return this.state(runId);
      }
      if (steps >= this.maxSteps) {
        await this.emit({
          type: 'RunCancelled',
          runId,
          at: this.now(),
          reason: `max steps exceeded (${this.maxSteps})`,
        });
        this.releaseController(runId);
        return this.state(runId);
      }
      await Promise.all(ready.map((nodeId) => this.executeNode(runId, nodeId, workflow, state)));
      await this.checkBudget(runId);
    }
  }

  private async checkBudget(runId: string): Promise<void> {
    const s = await this.state(runId);
    if (s.budgetUsd === undefined || s.status !== 'running') return;
    if (s.spentUsd >= s.budgetUsd) {
      await this.emit({
        type: 'BudgetExceeded',
        runId,
        at: this.now(),
        spentUsd: s.spentUsd,
        limitUsd: s.budgetUsd,
      });
    } else if (!s.budgetWarned && s.spentUsd >= 0.8 * s.budgetUsd) {
      await this.emit({
        type: 'BudgetWarning',
        runId,
        at: this.now(),
        spentUsd: s.spentUsd,
        limitUsd: s.budgetUsd,
      });
    }
  }

  private previousOutputs(state: RunState): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(state.nodes)
        .filter(([, n]) => n.status === 'completed')
        .map(([id, n]) => [id, n.output]),
    );
  }

  private async executeNode(
    runId: string,
    nodeId: string,
    workflow: Workflow,
    state: RunState,
  ): Promise<void> {
    const node = workflow.nodes[nodeId] as WorkflowNode;
    const at = () => this.now();
    await this.emit({ type: 'NodeStarted', runId, nodeId, at: at() });
    const attempts = (state.nodes[nodeId]?.attempts ?? 0) + 1;
    try {
      switch (node.type) {
        case 'task': {
          const role = this.deps.org.roles[node.role];
          if (!role) throw new Error(`role "${node.role}" is not defined`);
          const nodeState = state.nodes[nodeId];
          const resolved = Object.values(nodeState?.approvals ?? {}).filter(
            (a) => a.approved !== undefined,
          );
          const last = resolved.at(-1);
          const job: TaskJob = {
            runId,
            nodeId,
            role,
            instruction: node.instruction ?? '',
            input: state.input,
            workspace: state.workspace,
            context: {
              lastGateReport: state.lastGateReport,
              previousOutputs: this.previousOutputs(state),
            },
            budgetRemainingUsd:
              state.budgetUsd === undefined
                ? undefined
                : Math.max(0, state.budgetUsd - state.spentUsd),
            approvedCommands: Object.fromEntries(
              resolved.map((a) => [a.argvHash, a.approved as boolean]),
            ),
            // the last task of a run asked for a structured output answers in that shape
            outputSchema: outputSchemaFor(state, node),
            // a node suspended with a session resumes it; a fresh node starts clean
            resumeSessionId: nodeState?.sessionId,
            ...(workflow.conversation ? { conversation: true } : {}),
            resumeNote: resumeNoteFor(nodeState, last),
          };
          const runtimeId = this.deps.adapterFor
            ? this.deps.adapterFor(job)
            : (this.deps.defaultAdapter ?? role.runtime);
          const adapter = this.deps.adapters[runtimeId];
          if (!adapter) throw new Error(`no adapter registered for runtime "${runtimeId}"`);
          const pendingEmits: Promise<void>[] = [];
          const nodeSignal = this.nodeSignal(runId, nodeId);
          const result = await collectRun(adapter, job, {
            signal: nodeSignal,
            log: this.log,
            onEvent: (e) => this.onRuntimeEvent(runId, nodeId, e, pendingEmits),
          }).finally(() => {
            this.nodeControllers.delete(`${runId}:${nodeId}`);
            return Promise.all(pendingEmits);
          });
          await Promise.all(pendingEmits);
          if (job.outputSchema) {
            const problems = validateJson(result.output, job.outputSchema);
            if (problems.length)
              throw new AdapterError(
                `the output does not match the requested schema: ${problems.join('; ')}`,
                result.cost,
              );
          }
          await this.emit({
            type: 'NodeCompleted',
            runId,
            nodeId,
            at: at(),
            output: result.output,
            summary: result.summary,
            cost: result.cost,
          });
          return;
        }
        case 'code': {
          const r = await runCommand({
            command: node.command,
            cwd: state.workspace,
            timeoutMs: node.timeout_ms,
            env: this.deps.env,
          });
          const missing =
            node.skip_if_missing &&
            !r.timedOut &&
            (r.exitCode === 127 ||
              /command not found|not found|ENOENT|No such file/i.test(r.stderr));
          if (missing) {
            const program = node.command.trim().split(/\s+/)[0] ?? node.command;
            this.log(`[${runId}] ${nodeId}: skipped, ${program} is not installed`);
            await this.emit({
              type: 'NodeCompleted',
              runId,
              nodeId,
              at: at(),
              output: { exitCode: r.exitCode, skipped: true, stderr: r.stderr.slice(-500) },
              summary: `skipped: ${program} is not installed here`,
            });
            return;
          }
          if (r.exitCode !== 0 || r.timedOut)
            throw new Error(
              `\`${node.command}\` failed (exit ${r.exitCode}${r.timedOut ? ', timed out' : ''}): ${(r.stderr || r.stdout).slice(-500)}`,
            );
          await this.emit({
            type: 'NodeCompleted',
            runId,
            nodeId,
            at: at(),
            // the tail only: a verbose install would otherwise flood every later prompt
            output: { exitCode: r.exitCode, stdout: r.stdout.slice(-4000) },
            summary: `ran ${node.command}`,
          });
          return;
        }
        case 'git': {
          const summaries = Object.entries(state.nodes)
            .filter(([id, n]) => id !== nodeId && n.summary)
            .map(([id, n]) => ({ nodeId: id, summary: n.summary as string }));
          const ref = pullRequestRef(state);
          const texts: Record<string, string> = {};
          for (const [id, n] of Object.entries(state.nodes)) {
            const out = n.output as { text?: unknown } | undefined;
            const text = out && typeof out.text === 'string' ? out.text : n.summary;
            if (text) texts[id] = text;
          }
          const r = await runGitNode(node, {
            runId,
            workspace: state.workspace,
            project: state.project ?? state.workspace,
            branch: state.branch,
            base: state.baseBranch,
            env: this.deps.env,
            pr: ref?.number !== undefined ? { number: ref.number, url: ref.url } : undefined,
            texts,
            signal: this.controllerFor(runId).signal,
            spec:
              typeof state.input.spec === 'string' ? state.input.spec : JSON.stringify(state.input),
            summaries,
            describe: this.deps.describeChange,
            queue: this.deps.mergeQueue,
            log: (l) => this.log(`[${runId}] ${nodeId}: ${l}`),
          });
          await this.emit({
            type: 'NodeCompleted',
            runId,
            nodeId,
            at: at(),
            output: r.output,
            summary: r.summary,
          });
          return;
        }
        case 'decide': {
          const d = await this.deps.decider.decide({
            runId,
            nodeId,
            by: node.by,
            question: node.question ?? '',
            options: node.options,
            context: {
              input: state.input,
              previousOutputs: this.previousOutputs(state),
              lastGateReport: state.lastGateReport,
            },
            signal: this.controllerFor(runId).signal,
          });
          if (!node.options.includes(d.choice))
            throw new Error(
              `decider chose "${d.choice}" which is not one of ${node.options.join(', ')}`,
            );
          await this.emit({
            type: 'DecisionMade',
            runId,
            nodeId,
            at: at(),
            choice: d.choice,
            confidence: d.confidence,
            cost: d.cost,
          });
          return;
        }
        case 'gate': {
          const diffProvider = this.deps.diffProvider;
          const report = await runGate({
            gateIds: node.gates,
            gates: this.deps.org.gates,
            runners: this.checkRunners,
            ctx: {
              runId,
              nodeId,
              workspace: state.workspace,
              state,
              log: this.log,
              env: this.deps.env,
              signal: this.controllerFor(runId).signal,
              diff: diffProvider
                ? async () => {
                    try {
                      return await diffProvider(state.workspace);
                    } catch (e) {
                      this.log(
                        `[engine] diff unavailable: ${e instanceof Error ? e.message : String(e)}`,
                      );
                      return '';
                    }
                  }
                : undefined,
            },
          });
          if (report.passed) {
            await this.emit({
              type: 'GatePassed',
              runId,
              nodeId,
              at: at(),
              report,
              cost: report.cost,
            });
          } else if (attempts > node.max_retries) {
            await this.emit({
              type: 'NodeFailed',
              runId,
              nodeId,
              at: at(),
              error: `gate failed after ${attempts} attempts: ${report.checks
                .filter((c) => !c.passed && !c.skipped)
                .map((c) => c.name)
                .join(', ')}`,
            });
          } else {
            await this.emit({
              type: 'GateFailed',
              runId,
              nodeId,
              at: at(),
              report,
              rework: node.on_fail,
              cost: report.cost,
            });
          }
          return;
        }
        case 'human': {
          const prompt = node.prompt ?? `Approve "${node.action}"?`;
          await this.emit({
            type: 'HumanRequested',
            runId,
            nodeId,
            at: at(),
            action: node.action,
            prompt,
          });
          const afterRequest = await this.state(runId);
          // a sibling already ended the run this step (terminal runs clear pendingHumans)
          if (!afterRequest.pendingHumans.some((p) => p.nodeId === nodeId)) return;
          const answer = await this.deps.human.ask({ runId, nodeId, action: node.action, prompt });
          if ('deferred' in answer) return;
          await this.recordHuman(runId, nodeId, answer);
          return;
        }
        case 'parallel':
          await this.emit({
            type: 'NodeCompleted',
            runId,
            nodeId,
            at: at(),
            output: null,
            summary: `fan-out ${node.branches.join(', ')}`,
          });
          return;
      }
    } catch (e) {
      if (this.steered.delete(`${runId}:${nodeId}`) || e instanceof SteerSignal) {
        // the task was redirected: NodeSteered already put it back to pending with the note
        this.log(`[${runId}] ${nodeId}: steered, running it again with the note`);
        return;
      }
      if (e instanceof AdapterError && e.reason === 'approval_pending') {
        // only an approval the inbox recorded can be answered later; otherwise the task fails.
        // One already answered (the human beat the interruption) suspends too: the node then
        // re-runs at once with the answer in `approvedCommands`.
        const now = await this.state(runId);
        const known = now.nodes[nodeId]?.approvals ?? {};
        const pending = now.pendingApprovals.filter((p) => p.nodeId === nodeId);
        const approvalId =
          (e.approvalId && known[e.approvalId] ? e.approvalId : undefined) ??
          pending[0]?.approvalId;
        if (approvalId) {
          await this.emit({
            type: 'NodeSuspended',
            runId,
            nodeId,
            at: at(),
            sessionId: now.nodes[nodeId]?.sessionId,
            approvalId,
            ...(e.cost ? { cost: e.cost } : {}),
          });
          return;
        }
      }
      if (e instanceof AdapterError && e.reason === 'budget_exceeded') {
        const now = await this.state(runId);
        if (now.budgetUsd !== undefined) {
          await this.emit({
            type: 'BudgetExceeded',
            runId,
            nodeId,
            at: at(),
            spentUsd: now.spentUsd + (e.cost?.usd ?? 0),
            limitUsd: now.budgetUsd,
            ...(e.cost ? { cost: e.cost } : {}),
          });
          return;
        }
      }
      await this.emit({
        type: 'NodeFailed',
        runId,
        nodeId,
        at: at(),
        error: e instanceof Error ? e.message : String(e),
        ...(e instanceof AdapterError && e.cost ? { cost: e.cost } : {}),
      });
    }
  }
}

/** `input.output_schema` for a task with no `next` (the run's answer), nothing for the others. */
function outputSchemaFor(
  state: RunState,
  node: { next?: string },
): Record<string, unknown> | undefined {
  const schema = state.input.output_schema;
  if (node.next || !schema || typeof schema !== 'object' || Array.isArray(schema)) return undefined;
  return schema as Record<string, unknown>;
}

/** What a re-run task is told: the steering notes (newest last), then the answer to its approval. */
function resumeNoteFor(
  nodeState: NodeState | undefined,
  last: { command: string; approved?: boolean; note?: string } | undefined,
): string | undefined {
  const parts: string[] = [];
  const steering = nodeState?.steering ?? [];
  if (steering.length)
    parts.push(
      steering.length === 1
        ? `Steering from the operator (${steering[0]?.via}): ${steering[0]?.note}`
        : `Steering from the operator, in order:\n${steering.map((x) => `- (${x.via}) ${x.note}`).join('\n')}`,
    );
  if (last && nodeState?.sessionId)
    parts.push(
      `The approval for \`${last.command}\` was ${last.approved ? 'granted' : 'denied'}${last.note ? ` (${last.note})` : ''}. Continue the task.`,
    );
  else if (steering.length) parts.push('Continue the task.');
  return parts.length ? parts.join(parts.length > 1 && steering.length ? '\n\n' : ' ') : undefined;
}

/** The reason a steered task's signal aborts with. */
export class SteerSignal extends Error {
  constructor(
    readonly nodeId: string,
    readonly note: string,
  ) {
    super(`steered: ${note}`);
    this.name = 'SteerSignal';
  }
}

/**
 * Nodes left `running` by a crash become `pending` without a `startedIdx`, so
 * the scheduler treats them as never started and runs them again.
 */
function markInterrupted(state: RunState): RunState {
  const nodes = Object.fromEntries(
    Object.entries(state.nodes).map(([id, n]) => {
      if (n.status !== 'running') return [id, n];
      const { startedIdx: _startedIdx, ...rest } = n;
      return [id, { ...rest, status: 'pending' as const }];
    }),
  );
  return { ...state, nodes };
}
