import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

export interface FakeQueryCall {
  prompt: string;
  options: Options;
}
export type FakeScript = (call: FakeQueryCall) => AsyncIterable<SDKMessage> | SDKMessage[];

/** A stand-in for the SDK's `query` that replays a scripted message stream and records calls. */
export function fakeQuery(script: FakeScript) {
  const calls: FakeQueryCall[] = [];
  const fn = ({ prompt, options }: { prompt: string; options?: Options }) => {
    const call = { prompt: String(prompt), options: options ?? {} };
    calls.push(call);
    const out = script(call);
    async function* gen(): AsyncGenerator<SDKMessage> {
      for await (const m of out) yield m;
    }
    return gen();
  };
  return Object.assign(fn, { calls });
}

export const msg = {
  init: (
    extra: Partial<{
      model: string;
      tools: string[];
      mcp_servers: { name: string; status: string }[];
      apiKeySource: string;
      session_id: string;
    }> = {},
  ) =>
    ({
      type: 'system',
      subtype: 'init',
      model: 'claude-sonnet-5',
      tools: ['Read', 'Edit'],
      mcp_servers: [],
      cwd: '/w',
      apiKeySource: 'none',
      session_id: 'fake-session',
      ...extra,
    }) as unknown as SDKMessage,
  text: (text: string) =>
    ({
      type: 'assistant',
      message: { content: [{ type: 'text', text }] },
    }) as unknown as SDKMessage,
  toolUse: (id: string, name: string, input: unknown, extra: Record<string, unknown> = {}) =>
    ({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id, name, input }] },
      ...extra,
    }) as unknown as SDKMessage,
  toolResult: (id: string, content: unknown, extra: Record<string, unknown> = {}) =>
    ({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: id, content }] },
      ...extra,
    }) as unknown as SDKMessage,
  success: (
    result: string,
    extra: Partial<{
      total_cost_usd: number;
      structured_output: unknown;
      usage: { input_tokens: number; output_tokens: number };
    }> = {},
  ) =>
    ({
      type: 'result',
      subtype: 'success',
      result,
      total_cost_usd: 0.12,
      usage: { input_tokens: 100, output_tokens: 50 },
      num_turns: 2,
      permission_denials: [],
      is_error: false,
      ...extra,
    }) as unknown as SDKMessage,
  error: (subtype: string, cost = 0.05) =>
    ({
      type: 'result',
      subtype,
      total_cost_usd: cost,
      usage: { input_tokens: 10, output_tokens: 1 },
      is_error: true,
      num_turns: 1,
      permission_denials: [],
    }) as unknown as SDKMessage,
};
