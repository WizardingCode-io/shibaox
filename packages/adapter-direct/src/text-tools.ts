/** A tool call a model wrote as text instead of calling the tool. */
export interface TextToolCall {
  name: string;
  args: Record<string, unknown>;
}

const ARG_KEYS = ['arguments', 'args', 'input', 'parameters'] as const;

function asCall(v: unknown): TextToolCall | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.name !== 'string' || !o.name) return undefined;
  const key = ARG_KEYS.find((k) => k in o);
  if (!key) return undefined;
  const args = o[key];
  if (args === undefined || args === null) return { name: o.name, args: {} };
  if (typeof args !== 'object' || Array.isArray(args)) return undefined;
  return { name: o.name, args: args as Record<string, unknown> };
}

function parseCalls(json: string): TextToolCall[] | undefined {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return undefined;
  }
  const items = Array.isArray(v) ? v : [v];
  const calls = items.map(asCall);
  return calls.every((c) => c !== undefined) && calls.length > 0
    ? (calls as TextToolCall[])
    : undefined;
}

/** `<tools>…</tools>`, `<tool_call>…</tool_call>`, `<function_call>…</function_call>`. */
const TAGGED = /<(tools|tool_call|function_call)>\s*([\s\S]*?)\s*<\/\1>/g;
/** A fenced JSON block holding a call. */
const FENCED = /```(?:json)?\s*([\s\S]*?)```/g;
/** A bare `finish` line followed by its JSON object. */
const BARE_FINISH = /(?:^|\n)finish\s*\n\s*(\{[\s\S]*?\})\s*(?=\n|$)/g;

/**
 * Tool calls that a model without native tool calling wrote into its text, in the shapes such
 * models use, plus the text with those blocks taken out. Anything that is not a well-formed
 * call (`{ name, arguments|args|input|parameters }`) stays in the text untouched.
 */
export function parseTextToolCalls(text: string): { calls: TextToolCall[]; text: string } {
  const calls: TextToolCall[] = [];
  const spans: [number, number][] = [];
  const consider = (re: RegExp, pick: (m: RegExpExecArray) => TextToolCall[] | undefined) => {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const found = pick(m);
      if (!found) continue;
      const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
      if (spans.some(([a, b]) => start < b && m.index + m[0].length > a)) continue;
      spans.push([start, m.index + m[0].length]);
      calls.push(...found.map((c) => ({ ...c, at: start }) as TextToolCall & { at: number }));
    }
  };
  consider(TAGGED, (m) => parseCalls(m[2] ?? ''));
  consider(FENCED, (m) => parseCalls(m[1] ?? ''));
  consider(BARE_FINISH, (m) => {
    let args: unknown;
    try {
      args = JSON.parse(m[1] ?? '');
    } catch {
      return undefined;
    }
    return args && typeof args === 'object'
      ? [{ name: 'finish', args: args as Record<string, unknown> }]
      : undefined;
  });
  const ordered = (calls as (TextToolCall & { at: number })[])
    .sort((a, b) => a.at - b.at)
    .map(({ name, args }) => ({ name, args }));
  let out = '';
  let last = 0;
  for (const [a, b] of [...spans].sort((x, y) => x[0] - y[0])) {
    out += text.slice(last, a);
    last = b;
  }
  out += text.slice(last);
  return { calls: ordered, text: out.replace(/\n{3,}/g, '\n\n').trim() };
}
