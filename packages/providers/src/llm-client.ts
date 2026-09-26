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
}
export interface GenerateResult<T = unknown> {
  text: string;
  output?: T;
  usage: { inputTokens: number; outputTokens: number };
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
    output: args.output ? Output.object({ schema: args.output }) : undefined,
  });
  return {
    text: r.text,
    output: args.output ? (r.output as T) : undefined,
    usage: {
      inputTokens: r.usage.inputTokens ?? 0,
      outputTokens: r.usage.outputTokens ?? 0,
    },
    steps: r.steps.length,
    finishReason: r.finishReason,
  };
}

export class LlmClient {
  constructor(private readonly registry: ProviderRegistry) {}

  async generate<T = unknown>(
    ref: string,
    args: Omit<GenerateArgs, 'model'>,
  ): Promise<GenerateResult<T> & { cost?: number }> {
    const model = this.registry.model(ref);
    const r = await generate<T>({ ...args, model });
    return { ...r, cost: this.registry.estimateCost(ref, r.usage) };
  }
}
