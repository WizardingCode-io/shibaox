import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Capability,
  ExecutionContext,
  RuntimeAdapter,
  RuntimeEvent,
  TaskJob,
} from '@shibaox/core';
import {
  describeError,
  type GenerateResult,
  generate,
  type ProviderRegistry,
} from '@shibaox/providers';
import { buildTools } from './tools.js';

export interface DirectAdapterOptions {
  registry: ProviderRegistry;
  resolveRef: (job: TaskJob) => string;
  /** Org root used to resolve `role.system_prompt` paths. */
  orgRoot?: string;
  maxSteps?: number;
  commandTimeoutMs?: number;
  maxFileBytes?: number;
  /** Retries on retryable provider errors (AI SDK default: 2). */
  maxRetries?: number;
}

const RULES =
  'Rules: work only inside the workspace using the tools; never assume files exist without reading them; when the task is done call finish(output, summary) exactly once. If nothing needs to change, call finish with an explanation.';

type Settled = { ok: true; r: GenerateResult } | { ok: false; e: unknown };

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
    return `${prompt}\n\n${RULES}`;
  }

  private userMessage(job: TaskJob): string {
    return [
      `Task: ${job.instruction}`,
      `Input: ${JSON.stringify(job.input)}`,
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
    let pending: Promise<Settled>;
    let ref: string;
    try {
      ref = this.opts.resolveRef(job);
      const tools = buildTools({
        workspace: job.workspace,
        role: job.role,
        ctx,
        emit,
        onFinish: (output, summary) => {
          finished = { output, summary };
        },
        commandTimeoutMs: this.opts.commandTimeoutMs ?? 120_000,
        maxFileBytes: this.opts.maxFileBytes ?? 200_000,
      });
      pending = generate({
        model: this.opts.registry.model(ref),
        system: this.systemPrompt(job),
        messages: [{ role: 'user', content: this.userMessage(job) }],
        tools,
        maxSteps: this.opts.maxSteps ?? 12,
        stopOnTools: ['finish'],
        signal: ctx.signal,
        maxRetries: this.opts.maxRetries,
      }).then(
        (r): Settled => ({ ok: true, r }),
        (e: unknown): Settled => ({ ok: false, e }),
      );
    } catch (e) {
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

    if (!settled.ok) {
      // usage of a failed or aborted call is not reported by the SDK: no cost
      yield { type: 'error', message: describeError(settled.e) };
      return;
    }
    const { usage, text, finishReason, steps } = settled.r;
    const cost = {
      usd: this.opts.registry.estimateCost(ref, usage) ?? 0,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    };
    const maxSteps = this.opts.maxSteps ?? 12;
    if (!finished && (finishReason === 'tool-calls' || (steps >= maxSteps && text === ''))) {
      yield { type: 'error', message: `max steps (${maxSteps}) reached without finish`, cost };
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
