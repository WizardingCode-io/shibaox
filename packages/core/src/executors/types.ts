import {
  type ChatMessage,
  ChatMessageSchema,
  type Cost,
  type GateReport,
  type Role,
} from '@shibaox/schemas';
import type { z } from 'zod';

export type Capability = 'write-code' | 'run-tests' | 'read-only' | 'shell';

export type RuntimeEvent =
  | { type: 'started' }
  /** The runtime opened a resumable session (Claude Code `session_id`). */
  | { type: 'session'; runtime: string; sessionId: string }
  | { type: 'text'; text: string; parentToolUseId?: string }
  | { type: 'tool_use'; id?: string; name: string; input: unknown; parentToolUseId?: string }
  | {
      type: 'tool_result';
      id?: string;
      name: string;
      output: unknown;
      durationMs?: number;
      parentToolUseId?: string;
    }
  | { type: 'file_changed'; path: string }
  | { type: 'result'; output: unknown; summary: string; cost?: Cost }
  | {
      type: 'error';
      message: string;
      cost?: Cost;
      reason?: AdapterErrorReason;
      /** With `approval_pending`: the approval the task is waiting for. */
      approvalId?: string;
    };

/**
 * Why a task stopped, when the engine handles it specially: `budget_exceeded` pauses the run,
 * `approval_pending` suspends the node until the inbox answers.
 */
export type AdapterErrorReason = 'budget_exceeded' | 'approval_pending';

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
  /** Runtime session to resume (set when the node was suspended with a session id). */
  resumeSessionId?: string;
  /** What to tell the resumed session (which approval was granted or denied). */
  resumeNote?: string;
  /** argvHash → approved, for tool approvals already answered on this node. */
  approvedCommands: Record<string, boolean>;
}

export interface ExecutionContext {
  signal: AbortSignal;
  log: (line: string) => void;
  /** Every RuntimeEvent the adapter yields (for streaming); optional. */
  onEvent?: (e: RuntimeEvent) => void;
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
    readonly approvalId?: string,
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
    ctx.onEvent?.(event);
    if (event.type === 'text') ctx.log(event.text);
    if (event.type === 'error')
      throw new AdapterError(event.message, event.cost, event.reason, event.approvalId);
    if (event.type === 'result')
      return { output: event.output, summary: event.summary, cost: event.cost };
  }
  throw new Error(`adapter ${adapter.id} ended without a result for node ${job.nodeId}`);
}

/**
 * A tool the daemon hands to a task on top of the adapter's own: the direct adapter exposes
 * it as an AI SDK tool, the Claude Code adapter through an in-process MCP server.
 */
export interface AgentTool {
  name: string;
  description: string;
  input: z.ZodObject<z.ZodRawShape>;
  execute(input: Record<string, unknown>): Promise<unknown>;
}

/** The conversation carried in a run's input (`input.messages`), well-formed turns only. */
export function conversationOf(input: Record<string, unknown>): ChatMessage[] {
  const raw = input.messages;
  if (!Array.isArray(raw)) return [];
  const out: ChatMessage[] = [];
  for (const m of raw) {
    const r = ChatMessageSchema.safeParse(m);
    if (r.success) out.push(r.data);
  }
  return out;
}
