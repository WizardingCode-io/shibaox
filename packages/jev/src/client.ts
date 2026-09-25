import { type Questions, type SystemOneResult, TypeSafeClient } from '@typesafe-ai/sdk';

export const JEV_INPUT_USD_PER_M = 0.042;
export type { Questions };

export class JevClient {
  private readonly client: TypeSafeClient;
  private readonly apiKey: string | undefined;
  constructor(opts: { apiKey?: string; baseURL?: string; model?: string } = {}) {
    this.apiKey = opts.apiKey ?? process.env.TYPESAFE_API_KEY;
    this.client = new TypeSafeClient({
      apiKey: this.apiKey ?? 'missing',
      baseURL: opts.baseURL,
      defaultModel: opts.model,
    });
  }
  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }
  async fanOut<Q extends Questions>(state: unknown, questions: Q) {
    if (!this.isConfigured()) throw new Error('Jev is not configured: set TYPESAFE_API_KEY');
    const r = (await this.client.systemOne({
      state: state as never,
      questions,
    })) as SystemOneResult<Q>;
    const usage = { inputTokens: r.usage.input_tokens, outputTokens: r.usage.output_tokens };
    return {
      answers: r.answers,
      usage,
      cost: (usage.inputTokens / 1_000_000) * JEV_INPUT_USD_PER_M,
    };
  }
}

export function gateByConfidence(
  confidence: number,
  threshold: number,
  escalateBelow = 0.5,
): 'pass' | 'escalate' | 'fail' {
  if (confidence >= threshold) return 'pass';
  if (confidence >= escalateBelow) return 'escalate';
  return 'fail';
}

export function truncateState(
  parts: { spec?: string; output?: string; diff?: string },
  maxChars = 100_000,
): string {
  const sections: [string, string | undefined][] = [
    ['spec', parts.spec],
    ['output', parts.output],
    ['diff', parts.diff],
  ];
  let out = '';
  for (const [name, text] of sections) {
    if (!text) continue;
    const header = `## ${name}\n`;
    const room = maxChars - out.length - header.length - 1;
    if (room <= 0) break;
    out += `${header}${text.length > room ? `${text.slice(0, room - 1)}…` : text}\n`;
  }
  return out;
}
