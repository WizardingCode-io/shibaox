import { randomUUID } from 'node:crypto';
import type { Org, RunEvent, Workflow, WorkflowNode } from '@shibaox/schemas';
import type { EventStore } from '../events/store.js';
import { runCommand } from '../executors/code.js';
import { collectRun, type RuntimeAdapter, type TaskJob } from '../executors/types.js';
import { type CheckRunners, defaultCheckRunners, runGate } from '../gates/engine.js';
import { injectTeamGates } from '../org/inject-gates.js';
import type { Decider, HumanHandler } from './deciders.js';
import { replay } from './reducer.js';
import { readyNodes } from './scheduler.js';
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
}

export class RunEngine {
  private readonly log: (line: string) => void;
  private readonly now: () => string;
  private readonly maxSteps: number;
  private readonly checkRunners: CheckRunners;

  constructor(private readonly deps: EngineDeps) {
    this.log = deps.log ?? (() => {});
    this.now = deps.now ?? (() => new Date().toISOString());
    this.maxSteps = deps.maxSteps ?? 200;
    this.checkRunners = deps.checkRunners ?? defaultCheckRunners();
  }

  async start(opts: {
    workflow: string;
    input: Record<string, unknown>;
    workspace: string;
    budgetUsd?: number;
  }): Promise<RunState> {
    this.resolveWorkflow(opts.workflow);
    const runId = (this.deps.newRunId ?? randomUUID)();
    await this.emit({
      type: 'RunCreated',
      runId,
      at: this.now(),
      workflow: opts.workflow,
      input: opts.input,
      workspace: opts.workspace,
      budgetUsd: opts.budgetUsd,
    });
    return this.drive(runId);
  }

  async state(runId: string): Promise<RunState> {
    const events = await this.deps.store.read(runId);
    if (events.length === 0) throw new Error(`run ${runId} not found`);
    return replay(events);
  }

  async respond(runId: string, answer: { approved: boolean; note?: string }): Promise<RunState> {
    const state = await this.state(runId);
    if (state.status !== 'waiting_human' || !state.pendingHuman)
      throw new Error(`run ${runId} is not waiting for a human`);
    await this.recordHuman(runId, state.pendingHuman.nodeId, answer);
    return this.drive(runId);
  }

  async resume(runId: string, opts: { budgetUsd?: number } = {}): Promise<RunState> {
    const state = await this.state(runId);
    if (state.status === 'paused_budget') {
      await this.emit({ type: 'RunResumed', runId, at: this.now(), budgetUsd: opts.budgetUsd });
    } else if (state.status === 'waiting_human' && state.pendingHuman) {
      const answer = await this.deps.human.ask({ runId, ...state.pendingHuman });
      if ('deferred' in answer) return state;
      await this.recordHuman(runId, state.pendingHuman.nodeId, answer);
    } else if (state.status !== 'running') {
      return state;
    }
    return this.drive(runId, { interrupted: true });
  }

  private resolveWorkflow(name: string): Workflow {
    const wf = this.deps.org.workflows[name];
    if (!wf) throw new Error(`workflow "${name}" is not defined in the org`);
    const team = wf.team ? this.deps.org.teams[wf.team] : undefined;
    return team ? injectTeamGates(wf, team) : wf;
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
    if (!answer.approved)
      await this.emit({
        type: 'RunCancelled',
        runId,
        at: this.now(),
        reason: `rejected by human at ${nodeId}${answer.note ? `: ${answer.note}` : ''}`,
      });
  }

  private async drive(runId: string, opts: { interrupted?: boolean } = {}): Promise<RunState> {
    let interrupted = opts.interrupted ?? false;
    for (let steps = 0; ; steps++) {
      let state = await this.state(runId);
      if (interrupted) {
        state = markInterrupted(state);
        interrupted = false;
      }
      if (state.status !== 'running') return state;
      const workflow = this.resolveWorkflow(state.workflow);
      const ready = readyNodes(state, workflow);
      if (ready.length === 0) {
        await this.emit({ type: 'RunCompleted', runId, at: this.now() });
        return this.state(runId);
      }
      if (steps >= this.maxSteps) {
        await this.emit({
          type: 'RunCancelled',
          runId,
          at: this.now(),
          reason: `max steps exceeded (${this.maxSteps})`,
        });
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
            signal: new AbortController().signal,
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
            ctx: { runId, nodeId, workspace: state.workspace, state, log: this.log },
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
          if (afterRequest.status !== 'waiting_human') return; // a sibling already ended the run this step
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
      await this.emit({ type: 'NodeFailed', runId, nodeId, at: at(), error: (e as Error).message });
    }
  }
}

function markInterrupted(state: RunState): RunState {
  const nodes = Object.fromEntries(
    Object.entries(state.nodes).map(([id, n]) => [
      id,
      n.status === 'running' ? { ...n, status: 'pending' as const } : n,
    ]),
  );
  return { ...state, nodes };
}
