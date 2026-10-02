import { choice, noul, type Questions } from '@typesafe-ai/sdk';
import type { Cost } from '@wizardingcode/shibaox-schemas';
import type { JevClient } from './client.js';

/** The request text Jev sees at most. */
export const REQUEST_MAX_CHARS = 4_000;
/** The whole routing state at most (request, attachment names, workflows). */
export const STATE_MAX_CHARS = 8_000;
/** How long a turn waits for the route before it runs unrouted. */
export const ROUTE_TIMEOUT_MS = 8_000;
/** Below this the intent is `unsure` (TypeSafe's confidence-routing pattern). */
export const INTENT_MIN_CONFIDENCE = 0.6;
/** From this probability the request is flagged risky. */
export const RISKY_MIN_PROBABILITY = 0.7;

const MAX_ATTACHMENTS = 20;
const MAX_WORKFLOWS = 30;
const NAME_MAX = 120;
const DESCRIPTION_MAX = 200;

/** `fanOut` of a `JevClient` (tests pass a fake). */
export type RouteFanOut = (
  state: unknown,
  questions: Questions,
  opts?: { signal?: AbortSignal },
) => Promise<{
  answers: Record<string, unknown>;
  usage: { inputTokens: number; outputTokens: number };
  cost: number;
}>;

export interface RouteInput {
  /** The user's message. */
  request: string;
  /** The org's workflows; conversation ones are not offered as `workflow:<id>`. */
  workflows: { id: string; description?: string; conversation?: boolean }[];
  attachments?: { path: string; mime?: string }[];
  /** Media generation is set up (Higgsfield). */
  hasMedia?: boolean;
  /** The project is a code repository. */
  hasCode?: boolean;
}

export type RouteTier = 'cheap' | 'strong';

export interface RouteResult {
  /** `chat`, `media`, `code`, `research`, `workflow:<id>`, `human`, or `unsure` (below 0.6). */
  intent: string;
  intentConfidence: number;
  tier: RouteTier;
  tierConfidence: number;
  /** `riskyProbability` ≥ 0.7: the request asks to push, deploy, publish, delete, pay or message someone. */
  risky: boolean;
  riskyProbability: number;
  cost: Cost;
  model: 'jev-latest';
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

function routable(workflows: RouteInput['workflows']) {
  return (
    workflows
      // an id too long to offer whole is dropped: a cut id would name a workflow that does not exist
      .filter((w) => !w.conversation && w.id.length <= NAME_MAX)
      .slice(0, MAX_WORKFLOWS)
      .map((w) => ({
        id: w.id,
        description: cut(oneLine(w.description ?? ''), DESCRIPTION_MAX),
      }))
  );
}

function stateOf(input: RouteInput, workflows: { id: string; description: string }[]): string {
  const lines = [`## request\n${cut(input.request, REQUEST_MAX_CHARS)}`];
  const files = (input.attachments ?? []).slice(0, MAX_ATTACHMENTS);
  if (files.length > 0)
    lines.push(
      `## attached files\n${files.map((f) => `- ${cut(f.path, NAME_MAX)}${f.mime ? ` (${cut(f.mime, 60)})` : ''}`).join('\n')}`,
    );
  const can = [
    ...(input.hasMedia ? ['media generation (images, video, audio, 3D)'] : []),
    ...(input.hasCode ? ['a code project'] : []),
  ];
  if (can.length > 0) lines.push(`## available\n${can.join(', ')}`);
  if (workflows.length > 0)
    lines.push(
      `## workflows\n${workflows.map((w) => `- ${w.id}${w.description ? `: ${w.description}` : ''}`).join('\n')}`,
    );
  return cut(lines.join('\n\n'), STATE_MAX_CHARS);
}

function questionsFor(workflows: { id: string; description: string }[]): Questions {
  const intents: Record<string, string> = {
    chat: 'answer or discuss: a question, a conversation, an explanation',
    media: 'create an image, a video, audio or a 3D asset',
    code: 'change, build or fix software in the project',
    research: 'look things up on the web or in repositories',
  };
  for (const w of workflows)
    intents[`workflow:${w.id}`] =
      `run the workflow ${w.id}${w.description ? `: ${w.description}` : ''}`;
  intents.human = "needs a person's decision, or something only the user can do";
  return {
    intent: choice('What does the request ask for?', intents),
    tier: choice('How much model does the request need?', {
      cheap: 'a short, simple or conversational request',
      strong: 'reasoning, multi-step work, code changes, anything risky or ambiguous',
    }),
    risky: noul('The request asks to push, deploy, publish, delete, pay, send or message someone'),
  };
}

type ChoiceAnswer = { choice?: unknown; confidence?: unknown };
const isChoice = (a: unknown): a is { choice: string; confidence: number } =>
  typeof (a as ChoiceAnswer | undefined)?.choice === 'string' &&
  typeof (a as ChoiceAnswer | undefined)?.confidence === 'number';

/**
 * Routes one chat turn with ONE Jev fan-out: what it asks for (`intent`), how much model it
 * needs (`tier`) and whether it is risky. Never throws: any error or a timeout (8 s) gives
 * `undefined` (`onError` hears why) and the turn runs unrouted.
 */
export async function routeRequest(
  fanOut: RouteFanOut | Pick<JevClient, 'fanOut'>,
  input: RouteInput,
  opts: { timeoutMs?: number; signal?: AbortSignal; onError?: (e: Error) => void } = {},
): Promise<RouteResult | undefined> {
  const call: RouteFanOut =
    typeof fanOut === 'function'
      ? fanOut
      : (s, q, o) => (fanOut as JevClient).fanOut(s, q, o) as ReturnType<RouteFanOut>;
  const timeoutMs = opts.timeoutMs ?? ROUTE_TIMEOUT_MS;
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (opts.signal?.aborted) ctrl.abort();
  else opts.signal?.addEventListener('abort', onAbort);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const workflows = routable(input.workflows);
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Jev routing timed out after ${timeoutMs} ms`));
        ctrl.abort();
      }, timeoutMs);
    });
    const r = await Promise.race([
      call(stateOf(input, workflows), questionsFor(workflows), { signal: ctrl.signal }),
      timeout,
    ]);
    const intent = r.answers.intent;
    const tier = r.answers.tier;
    const risky = (r.answers.risky as { noul?: unknown } | undefined)?.noul;
    if (!isChoice(intent)) throw new Error('Jev did not answer intent');
    if (!isChoice(tier) || (tier.choice !== 'cheap' && tier.choice !== 'strong'))
      throw new Error('Jev did not answer tier');
    if (typeof risky !== 'number') throw new Error('Jev did not answer risky');
    return {
      intent: intent.confidence < INTENT_MIN_CONFIDENCE ? 'unsure' : intent.choice,
      intentConfidence: intent.confidence,
      tier: tier.choice,
      tierConfidence: tier.confidence,
      risky: risky >= RISKY_MIN_PROBABILITY,
      riskyProbability: risky,
      cost: { usd: r.cost, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens },
      model: 'jev-latest',
    };
  } catch (e) {
    opts.onError?.(e instanceof Error ? e : new Error(String(e)));
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

/** `[router] intent=media (0.98) tier=cheap risky=no` (the log line, the start of the hint). */
export function routeLine(r: RouteResult): string {
  return `[router] intent=${r.intent} (${r.intentConfidence.toFixed(2)}) tier=${r.tier} risky=${r.risky ? 'yes' : 'no'}`;
}

/**
 * The line the orchestrator reads before the user's message:
 * `[router] intent=media (0.98) tier=cheap risky=no: generate it with Higgsfield now` (the
 * media advice only when media generation is set up, `hasMedia`).
 */
export function routeHint(r: RouteResult, opts: { hasMedia?: boolean } = {}): string {
  const line = routeLine(r);
  const wf = r.intent.startsWith('workflow:') ? r.intent.slice('workflow:'.length) : undefined;
  const todo =
    r.intent === 'media' && opts.hasMedia
      ? 'generate it with Higgsfield now'
      : wf
        ? `start workflow ${wf} with start_workflow unless the user is only asking about it`
        : r.intent === 'research'
          ? 'use your fetch/search tools'
          : r.intent === 'human'
            ? 'ask one precise question'
            : undefined;
  return todo ? `${line}: ${todo}` : line;
}
