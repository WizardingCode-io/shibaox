import type { Cost, GateReport, Role } from '@shibaox/schemas';

export type Capability = 'write-code' | 'run-tests' | 'read-only' | 'shell';

export type RuntimeEvent =
  | { type: 'started' }
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; input: unknown }
  | { type: 'tool_result'; name: string; output: unknown }
  | { type: 'file_changed'; path: string }
  | { type: 'result'; output: unknown; summary: string; cost?: Cost }
  | { type: 'error'; message: string; cost?: Cost; reason?: AdapterErrorReason };

/** Why a task stopped, when the engine handles it specially (`budget_exceeded`: pause, not fail). */
export type AdapterErrorReason = 'budget_exceeded';

export interface TaskJob {
  runId: string;
  nodeId: string;
  role: Role;
  instruction: string;
  input: Record<string, unknown>;
  workspace: string;
  context: { lastGateReport?: GateReport; previousOutputs: Record<string, unknown> };
  /** What is left of the run budget (USD) when the run has one; adapters may cap spend with it. */
  budgetRemainingUsd?: number;
  /** JSON Schema the task output should conform to, for adapters that support structured output. */
  outputSchema?: Record<string, unknown>;
}

export interface ExecutionContext {
  signal: AbortSignal;
  log: (line: string) => void;
}

export interface TaskResult {
  output: unknown;
  summary: string;
  cost?: Cost;
}

export interface RuntimeAdapter {
  readonly id: string;
  capabilities(): Capability[];
  run(job: TaskJob, ctx: ExecutionContext): AsyncIterable<RuntimeEvent>;
}

/** A task failure reported by an adapter, carrying what the attempt cost (if known). */
export class AdapterError extends Error {
  constructor(
    message: string,
    readonly cost?: Cost,
    readonly reason?: AdapterErrorReason,
  ) {
    super(message);
    this.name = 'AdapterError';
  }
}

export async function collectRun(
  adapter: RuntimeAdapter,
  job: TaskJob,
  ctx: ExecutionContext,
): Promise<TaskResult> {
  for await (const event of adapter.run(job, ctx)) {
    if (event.type === 'text') ctx.log(event.text);
    if (event.type === 'error') throw new AdapterError(event.message, event.cost, event.reason);
    if (event.type === 'result')
      return { output: event.output, summary: event.summary, cost: event.cost };
  }
  throw new Error(`adapter ${adapter.id} ended without a result for node ${job.nodeId}`);
}
