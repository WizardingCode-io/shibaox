import {
  type FinishReason,
  generateText,
  hasToolCall,
  isStepCount,
  type LanguageModel,
  type ModelMessage,
  Output,
  type ToolSet,
} from 'ai';
import type { z } from 'zod';
import type { ProviderRegistry } from './registry.js';

export interface GenerateArgs {
  model: LanguageModel;
  system?: string;
  messages: ModelMessage[];
  tools?: ToolSet;
  maxSteps?: number;
  /** Stop the agent loop right after any of these tools is called (in addition to maxSteps). */
  stopOnTools?: string[];
  output?: z.ZodType;
  signal?: AbortSignal;
  /** Retries on retryable provider errors (AI SDK default: 2). */
  maxRetries?: number;
}
export interface GenerateResult<T = unknown> {
  text: string;
  output?: T;
  /** Totals over every step of the call. */
  usage: { inputTokens: number; outputTokens: number };
  /** Input tokens of the last step: what the model's context held at the end. */
  lastStepInputTokens: number;
  steps: number;
  /** Why the last step ended (e.g. 'stop', 'tool-calls', 'length'). */
  finishReason: FinishReason;
}

export async function generate<T = unknown>(args: GenerateArgs): Promise<GenerateResult<T>> {
  // Verified against the installed ai@7.0.116: generateText accepts `tools` and
  // `output` together (no runtime or type-level restriction), so both are passed
  // through unconditionally as in the brief's reference implementation.
  const r = await generateText({
    model: args.model,
    system: args.system,
    messages: args.messages,
    tools: args.tools,
    stopWhen: args.stopOnTools?.length
      ? [isStepCount(args.maxSteps ?? 1), hasToolCall(...args.stopOnTools)]
      : isStepCount(args.maxSteps ?? 1),
    abortSignal: args.signal,
    maxRetries: args.maxRetries,
    output: args.output ? Output.object({ schema: args.output }) : undefined,
  });
  return {
    text: r.text,
    output: args.output ? (r.output as T) : undefined,
    usage: {
      inputTokens: r.usage.inputTokens ?? 0,
      outputTokens: r.usage.outputTokens ?? 0,
    },
    lastStepInputTokens: r.steps.at(-1)?.usage.inputTokens ?? r.usage.inputTokens ?? 0,
    steps: r.steps.length,
    finishReason: r.finishReason,
  };
}

export class LlmClient {
  constructor(
    private readonly registry: ProviderRegistry,
    /** Defaults for every call; `maxRetries` in the call args wins. */
    private readonly defaults: { maxRetries?: number } = {},
  ) {}

  async generate<T = unknown>(
    ref: string,
    args: Omit<GenerateArgs, 'model'>,
  ): Promise<GenerateResult<T> & { cost?: number }> {
    const model = this.registry.model(ref);
    const r = await generate<T>({
      ...args,
      model,
      maxRetries: args.maxRetries ?? this.defaults.maxRetries,
    });
    return { ...r, cost: this.registry.estimateCost(ref, r.usage) };
  }
}
