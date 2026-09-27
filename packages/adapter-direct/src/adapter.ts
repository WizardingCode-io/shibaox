import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AgentTool,
  type ApprovalHandler,
  type Capability,
  conversationOf,
  type ExecutionContext,
  type RuntimeAdapter,
  type RuntimeEvent,
  type TaskJob,
} from '@shibaox/core';
import {
  describeError,
  type GenerateResult,
  generate,
  type ProviderRegistry,
} from '@shibaox/providers';
import { APPROVAL_PENDING, buildTools } from './tools.js';

export interface DirectAdapterOptions {
  registry: ProviderRegistry;
  resolveRef: (job: TaskJob) => string;
  /** Answers push/deploy commands for roles with `approval_required`. */
  approvals: ApprovalHandler;
  /** Org root used to resolve `role.system_prompt` paths. */
  orgRoot?: string;
  maxSteps?: number;
  commandTimeoutMs?: number;
  maxFileBytes?: number;
  /** Retries on retryable provider errors (AI SDK default: 2). */
  maxRetries?: number;
  /** When given, exposes a `graph_query` tool that answers questions from the knowledge graph. */
  graphQuery?: (question: string) => Promise<string>;
  /** Tools the daemon adds for this job (orchestration, memory), exposed under their own names. */
  extraTools?: (job: TaskJob) => AgentTool[];
  /** Context appended to the system prompt (project profile, memory). */
  preamble?: (job: TaskJob) => string | undefined;
}

const RULES =
  'Rules: work only inside the workspace using the tools; never assume files exist without reading them; when the task is done call finish(output, summary) exactly once. If nothing needs to change, call finish with an explanation.';
/** A conversation turn: the answer is the reply text; tools only when the request needs them. */
const CHAT_RULES =
  'Rules: answer the user directly in your reply text, in their language. Use the tools only when the request needs them (reading or writing files in the workspace, running a listed program, fetching a page, dispatching a workflow); after using tools, still answer in text. Never describe a tool call in text: either call the tool or answer. Do not call finish for a plain answer.';

type Settled = { ok: true; r: GenerateResult } | { ok: false; e: unknown };

/**
 * What the conversation shows for a call: the model's text; without it, what finish() carried
 * (a string output, an output `text`, else the summary).
 */
export function replyText(
  text: string,
  finished: { output: unknown; summary: string } | undefined,
): string {
  if (text.trim()) return text.trim();
  if (!finished) return '';
  const out = finished.output;
  if (typeof out === 'string' && out.trim()) return out.trim();
  const inner = (out as { text?: unknown } | null | undefined)?.text;
  if (typeof inner === 'string' && inner.trim()) return inner.trim();
  return finished.summary.trim();
}

export class DirectAdapter implements RuntimeAdapter {
  readonly id = 'direct';
  constructor(private readonly opts: DirectAdapterOptions) {}

  capabilities(): Capability[] {
    return ['write-code', 'run-tests', 'shell'];
  }

  private systemPrompt(job: TaskJob): string {
    let prompt = job.role.description ?? `You are the ${job.role.role}.`;
    if (job.role.system_prompt && this.opts.orgRoot) {
      const p = join(this.opts.orgRoot, job.role.system_prompt);
      if (existsSync(p)) prompt = readFileSync(p, 'utf8');
    }
    const preamble = this.opts.preamble?.(job);
    const rules = job.conversation ? CHAT_RULES : RULES;
    return `${prompt}\n\n${rules}${preamble ? `\n\n${preamble}` : ''}`;
  }

  private userMessage(job: TaskJob): string {
    // the conversation travels as its own turns (see run), never inside the input JSON
    const { messages: _messages, ...input } = job.input;
    return [
      `Task: ${job.instruction}`,
      `Input: ${JSON.stringify(input)}`,
      `Previous outputs: ${JSON.stringify(job.context.previousOutputs).slice(0, 60_000)}`,
      `Last gate report: ${JSON.stringify(job.context.lastGateReport ?? null).slice(0, 20_000)}`,
    ].join('\n\n');
  }

  async *run(job: TaskJob, ctx: ExecutionContext): AsyncIterable<RuntimeEvent> {
    yield { type: 'started' };
    // Tool events are pushed from inside tool `execute` while generate is in
    // flight; `wake` resolves the waiting loop as soon as one arrives, so no
    // polling timer is needed and ordering is preserved.
    const queue: RuntimeEvent[] = [];
    let wake: (() => void) | undefined;
    const emit = (e: RuntimeEvent) => {
      queue.push(e);
      wake?.();
    };
    let finished: { output: unknown; summary: string } | undefined;
    let suspended: { approvalId: string } | undefined;
    // a deferred approval aborts the model call; the task then ends with approval_pending
    const abort = new AbortController();
    const onAbort = () => abort.abort(ctx.signal.reason);
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    let pending: Promise<Settled>;
    let ref: string;
    let effectiveMaxSteps: number;
    try {
      ref = this.opts.resolveRef(job);
      yield { type: 'usage', model: ref };
      // Models without tool-calling support (registry.supportsTools) get a single
      // plain-text turn instead: no tools are sent and the reply is the result.
      const supportsTools = this.opts.registry.supportsTools(ref);
      effectiveMaxSteps = supportsTools ? (job.role.max_steps ?? this.opts.maxSteps ?? 12) : 1;
      const tools = supportsTools
        ? buildTools({
            workspace: job.workspace,
            role: job.role,
            runId: job.runId,
            nodeId: job.nodeId,
            ctx,
            emit,
            onFinish: (output, summary) => {
              finished = { output, summary };
            },
            approvals: this.opts.approvals,
            approvedCommands: job.approvedCommands ?? {},
            onSuspend: (approvalId) => {
              suspended = { approvalId };
              abort.abort(new Error(APPROVAL_PENDING));
            },
            commandTimeoutMs: this.opts.commandTimeoutMs ?? 120_000,
            maxFileBytes: this.opts.maxFileBytes ?? 200_000,
            graphQuery: this.opts.graphQuery,
            extraTools: this.opts.extraTools?.(job) ?? [],
          })
        : undefined;
      pending = generate({
        model: this.opts.registry.model(ref),
        system: this.systemPrompt(job),
        messages: [
          ...conversationOf(job.input).map((m) => ({ role: m.role, content: m.content })),
          { role: 'user' as const, content: this.userMessage(job) },
        ],
        tools,
        maxSteps: effectiveMaxSteps,
        stopOnTools: supportsTools ? ['finish'] : undefined,
        signal: abort.signal,
        maxRetries: this.opts.maxRetries,
      })
        .then(
          (r): Settled => ({ ok: true, r }),
          (e: unknown): Settled => ({ ok: false, e }),
        )
        .finally(() => ctx.signal.removeEventListener('abort', onAbort));
    } catch (e) {
      ctx.signal.removeEventListener('abort', onAbort);
      yield { type: 'error', message: describeError(e) };
      return;
    }

    let settled: Settled | undefined;
    while (!settled) {
      while (queue.length > 0) yield queue.shift() as RuntimeEvent;
      const next = await Promise.race([
        pending,
        new Promise<undefined>((res) => {
          wake = () => res(undefined);
        }),
      ]);
      wake = undefined;
      settled = next;
    }
    while (queue.length > 0) yield queue.shift() as RuntimeEvent;

    if (suspended) {
      yield {
        type: 'error',
        message: `approval pending: task ${job.nodeId} waits for the inbox`,
        reason: 'approval_pending',
        approvalId: suspended.approvalId,
      };
      return;
    }
    if (!settled.ok) {
      // usage of a failed or aborted call is not reported by the SDK: no cost
      yield { type: 'error', message: describeError(settled.e) };
      return;
    }
    const { usage, text, finishReason, steps, lastStepInputTokens } = settled.r;
    const cost = {
      usd: this.opts.registry.estimateCost(ref, usage) ?? 0,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    };
    // the model's answer is a text event, like any runtime's: the conversation view shows
    // text, never raw results. Without finish() it is the reply; with finish() the text output.
    const reply = replyText(text, finished);
    if (reply) yield { type: 'text', text: reply };
    const contextWindow = this.opts.registry.contextWindow(ref);
    yield {
      type: 'usage',
      model: ref,
      contextTokens: lastStepInputTokens,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      ...(contextWindow ? { contextWindow } : {}),
    };
    if (
      !finished &&
      (finishReason === 'tool-calls' || (steps >= effectiveMaxSteps && text === ''))
    ) {
      yield {
        type: 'error',
        message: `max steps (${effectiveMaxSteps}) reached without finish`,
        cost,
      };
      return;
    }
    // truncated ('length'), filtered ('content-filter') or failed output is not a result
    if (!finished && finishReason !== 'stop') {
      yield {
        type: 'error',
        message: `model stopped with reason "${finishReason}" without finish`,
        cost,
      };
      return;
    }
    if (finished)
      yield { type: 'result', output: finished.output, summary: finished.summary, cost };
    else yield { type: 'result', output: { text }, summary: text.slice(0, 200), cost };
  }
}
