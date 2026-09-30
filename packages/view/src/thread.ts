import type { RunState } from '@wizardingcode/shibaox-core';
import { isEventTurn } from './conversation.js';
import { requestText } from './request.js';
import type { Block, Card } from './stream.js';

/** The words of the design system's AgentStatus. */
export type AgentStatus = 'online' | 'working' | 'waiting' | 'idle' | 'error';

export interface ThreadMessage {
  key: string;
  from: 'user' | 'agent';
  text: string;
  /** ISO time of the turn (the run's creation for the user, its end for the agent). */
  time?: string;
  /** Tool calls and files of the agent's turn, in order. */
  blocks: Block[];
  /** The agent has not answered yet (its run is still going). */
  pending?: boolean;
  runId: string;
}

export interface ThreadTurn {
  state: RunState;
  cards: Card[];
  /** From the run summary (the state carries no clock). */
  createdAt?: string;
  updatedAt?: string;
}

export interface ThreadView {
  title: string;
  status: AgentStatus;
  messages: ThreadMessage[];
  /** Runs still going, oldest first. */
  running: string[];
}

/** What the agent said in a turn: the top-level text blocks of its task nodes, in order. */
export function replyText(cards: readonly Card[]): string {
  return cards
    .flatMap((c) => (c.kind === 'node' ? c.blocks : []))
    .flatMap((b) => (b.kind === 'text' && !b.parentId ? [b.text.trim()] : []))
    .join('\n')
    .trim();
}

const LIVE = new Set<RunState['status']>(['running', 'queued']);
const WAITING = new Set<RunState['status']>(['waiting_human', 'waiting_approval', 'paused_budget']);

/** The run state as the agent's live status word. */
export function agentStatusOf(state: RunState | undefined): AgentStatus {
  if (!state) return 'idle';
  if (WAITING.has(state.status)) return 'waiting';
  if (state.pendingApprovals.length > 0 || state.pendingHumans.length > 0) return 'waiting';
  if (LIVE.has(state.status)) return 'working';
  if (state.status === 'completed') return 'online';
  return 'error';
}

/**
 * A conversation as the thread screen shows it: each turn is a user message (the request)
 * followed by the agent's reply with its tool calls; event turns (a dispatched run ended)
 * show only the agent's side. The title is the first request; the status follows the
 * latest turn.
 */
export function threadView(turns: readonly ThreadTurn[]): ThreadView {
  const messages: ThreadMessage[] = [];
  const running: string[] = [];
  let title = '';
  for (const { state, cards, createdAt, updatedAt } of turns) {
    const event = isEventTurn(state.input);
    const request = requestText(state.input);
    if (!title && !event) title = request;
    if (!event)
      messages.push({
        key: `${state.runId}:user`,
        from: 'user',
        text: request,
        time: createdAt,
        blocks: [],
        runId: state.runId,
      });
    const blocks = cards
      .flatMap((c) => (c.kind === 'node' ? c.blocks : []))
      .filter((b) => b.kind !== 'text');
    const text = replyText(cards);
    const live = LIVE.has(state.status) || WAITING.has(state.status);
    if (live) running.push(state.runId);
    // an event turn with nothing to say yet shows nothing; a user's turn shows the agent thinking
    if (text || blocks.length > 0 || (live && !event))
      messages.push({
        key: `${state.runId}:agent`,
        from: 'agent',
        text,
        time: updatedAt,
        blocks,
        pending: live && !text,
        runId: state.runId,
      });
  }
  const last = turns[turns.length - 1]?.state;
  return { title, status: agentStatusOf(last), messages, running };
}
