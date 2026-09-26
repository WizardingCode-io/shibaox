import { randomUUID } from 'node:crypto';
import type { Org, RunEvent, Workflow, WorkflowNode } from '@shibaox/schemas';
import type { EventStore, RunSummary } from '../events/store.js';
import { runCommand } from '../executors/code.js';
import { AdapterError, collectRun, type RuntimeAdapter, type TaskJob } from '../executors/types.js';
import { type CheckRunners, defaultCheckRunners, runGate } from '../gates/engine.js';
import { injectTeamGates } from '../org/inject-gates.js';
import type { Decider, HumanHandler } from './deciders.js';
import { isTerminal, replay } from './reducer.js';
import { isStalled, readyNodes } from './scheduler.js';
import type { RunState } from './state.js';

export interface EngineDeps {
  store: EventStore;
  org: Org;
  adapters: Record<string, RuntimeAdapter>;
  defaultAdapter?: string;
  decider: Decider;
  human: HumanHandler;
  checkRunners?: CheckRunners;
  log?: (line: string) => void;
  now?: () => string;
  maxSteps?: number;
  newRunId?: () => string;
  scheduler?: { readyNodes: typeof readyNodes; isStalled: typeof isStalled };
}

export class RunEngine {
  private readonly log: (line: string) => void;
  private readonly now: () => string;
  private readonly maxSteps: number;
  private readonly checkRunners: CheckRunners;
  private readonly scheduler: { readyNodes: typeof readyNodes; isStalled: typeof isStalled };
  private readonly controllers = new Map<string, AbortController>();

  constructor(private readonly deps: EngineDeps) {
    this.log = deps.log ?? (() => {});
    this.now = deps.now ?? (() => new Date().toISOString());
    this.maxSteps = deps.maxSteps ?? 200;
    this.checkRunners = deps.checkRunners ?? defaultCheckRunners();
    this.scheduler = deps.scheduler ?? { readyNodes, isStalled };
  }

  async start(opts: {
    workflow: string;
    input: Record<string, unknown>;
    workspace: string;
    budgetUsd?: number;
  }): Promise<RunState> {
    const workflowSnapshot = this.resolveFromOrg(opts.workflow);
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
    });
    return this.drive(runId);
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

  async listRuns(): Promise<RunSummary[]> {
    return this.deps.store.listRuns();
  }

  /** Number of runs with a live AbortController (test/observability helper). */
  controllerCount(): number {
    return this.controllers.size;
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
    answer: { approved: boolean; note?: string },
  ): Promise<void> {
    await this.emit({
      type: 'HumanResponded',
      runId,
      nodeId,
      at: this.now(),
      approved: answer.approved,
      note: answer.note,
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
          const runtimeId = this.deps.defaultAdapter ?? role.runtime;
          const adapter = this.deps.adapters[runtimeId];
          if (!adapter) throw new Error(`no adapter registered for runtime "${runtimeId}"`);
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
          };
          const result = await collectRun(adapter, job, {
            signal: this.controllerFor(runId).signal,
            log: this.log,
          });
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
          });
          if (r.exitCode !== 0 || r.timedOut)
            throw new Error(
              `command failed (exit ${r.exitCode}${r.timedOut ? ', timed out' : ''}): ${r.stderr.slice(-500)}`,
            );
          await this.emit({
            type: 'NodeCompleted',
            runId,
            nodeId,
            at: at(),
            output: { exitCode: r.exitCode, stdout: r.stdout },
            summary: `ran ${node.command}`,
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
              signal: this.controllerFor(runId).signal,
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
