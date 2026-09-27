import {
  type FinishReason,
  generateText,
  hasToolCall,
  isStepCount,
  type LanguageModel,
  type ModelMessage,
  Output,
  streamText,
  type ToolSet,
} from 'ai';
import { z } from 'zod';
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
  /** Cap on the tokens the model may write per step. */
  maxOutputTokens?: number;
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
    maxOutputTokens: args.maxOutputTokens,
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

/**
 * `generate`, streamed: `onText` gets the model's text as it arrives (tool calls still run
 * between steps); the result is the same shape as `generate` once the stream ends.
 */
export async function generateStream<T = unknown>(
  args: GenerateArgs & { onText?: (delta: string) => void },
): Promise<GenerateResult<T>> {
  const r = streamText({
    model: args.model,
    system: args.system,
    messages: args.messages,
    tools: args.tools,
    stopWhen: args.stopOnTools?.length
      ? [isStepCount(args.maxSteps ?? 1), hasToolCall(...args.stopOnTools)]
      : isStepCount(args.maxSteps ?? 1),
    abortSignal: args.signal,
    maxRetries: args.maxRetries,
    maxOutputTokens: args.maxOutputTokens,
  });
  let failure: unknown;
  for await (const part of r.fullStream) {
    if (part.type === 'text-delta') args.onText?.(part.text);
    else if (part.type === 'error') failure = part.error;
  }
  if (failure) throw failure;
  const [text, usage, steps, finishReason] = await Promise.all([
    r.text,
    r.usage,
    r.steps,
    r.finishReason,
  ]);
  return {
    text,
    output: undefined,
    usage: { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 },
    lastStepInputTokens: steps.at(-1)?.usage.inputTokens ?? usage.inputTokens ?? 0,
    steps: steps.length,
    finishReason,
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

  /** `generate` with the text streamed to `onText`. */
  async generateStream<T = unknown>(
    ref: string,
    args: Omit<GenerateArgs, 'model'> & { onText?: (delta: string) => void },
  ): Promise<GenerateResult<T> & { cost?: number }> {
    const model = this.registry.model(ref);
    const r = await generateStream<T>({
      ...args,
      model,
      maxRetries: args.maxRetries ?? this.defaults.maxRetries,
    });
    return { ...r, cost: this.registry.estimateCost(ref, r.usage) };
  }

  /**
   * A structured answer: the provider's JSON mode first; when the model cannot do that
   * (routers and small local models answer in prose), the same prompt again asking for the
   * JSON object in plain text, which is then extracted and validated against `schema`.
   */
  async generateObject<T>(
    ref: string,
    args: Omit<GenerateArgs, 'model' | 'output'>,
    schema: z.ZodType<T>,
  ): Promise<GenerateResult<T> & { cost?: number; output: T }> {
    try {
      const r = await this.generate<T>(ref, { ...args, output: schema });
      if (r.output !== undefined) return { ...r, output: r.output };
    } catch (e) {
      if (!isNoObjectError(e)) throw e;
    }
    const plain = await this.generate<T>(ref, {
      ...args,
      messages: [
        ...args.messages,
        {
          role: 'user',
          content: `Answer with one JSON object only, no prose around it, matching this JSON Schema:\n${JSON.stringify(z.toJSONSchema(schema))}`,
        },
      ],
    });
    const output = schema.parse(extractJson(plain.text));
    return { ...plain, output };
  }
}

const isNoObjectError = (e: unknown): boolean =>
  e instanceof Error &&
  (e.name === 'AI_NoObjectGeneratedError' ||
    /No object generated|did not match schema/i.test(e.message));

/** The first JSON object in a text (models wrap it in prose or code fences). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];
  const candidates = [fenced, text].filter((t): t is string => typeof t === 'string');
  for (const t of candidates) {
    const start = t.indexOf('{');
    if (start < 0) continue;
    let depth = 0;
    let inString = false;
    for (let i = start; i < t.length; i++) {
      const ch = t[i];
      if (inString) {
        if (ch === '\\') i++;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(t.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  throw new Error(`no JSON object in the model's answer: ${text.slice(0, 200)}`);
}
