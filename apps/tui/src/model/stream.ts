import type { NodeStatus, RunState, RunStatus } from '@shibaox/core';
import type { Envelope } from '@shibaox/daemon';
import type { WorkflowNode } from '@shibaox/schemas';

/** `key` is stable across reductions so the screen can reconcile instead of remounting. */
export type Block =
  | { kind: 'text'; key: string; text: string; parentId?: string }
  | {
      kind: 'tool';
      key: string;
      id: string;
      name: string;
      summary: string;
      input: unknown;
      output?: unknown;
      ms?: number;
      status: 'running' | 'done' | 'error';
      parentId?: string;
    }
  | { kind: 'file'; key: string; path: string };

export type Card =
  | {
      kind: 'node';
      key: string;
      nodeId: string;
      type: 'task' | 'code';
      role?: string;
      runtime?: string;
      status: NodeStatus;
      attempts: number;
      costUsd?: number;
      startedAt?: string;
      endedAt?: string;
      blocks: Block[];
      tools: number;
    }
  | {
      kind: 'gate';
      key: string;
      nodeId: string;
      status: NodeStatus;
      checks: { name: string; passed: boolean; ms?: number; message?: string }[];
      passed?: boolean;
      report?: string;
      attempts: number;
    }
  | {
      kind: 'decide';
      key: string;
      nodeId: string;
      status: NodeStatus;
      choice?: string;
      confidence?: number;
    }
  | {
      kind: 'human';
      key: string;
      nodeId: string;
      prompt: string;
      action?: string;
      pending: boolean;
      answer?: { approved: boolean; note?: string; via?: string; at: string };
    }
  | { kind: 'error'; key: string; nodeId?: string; message: string }
  | { kind: 'earlier'; key: string; count: number }
  | {
      kind: 'summary';
      key: string;
      status: RunStatus;
      costUsd: number;
      durationMs?: number;
      files: string[];
      branch?: string;
      error?: string;
    };

export const CARD_LIMIT = 5000;
const SUMMARY_LIMIT = 80;

/** Run events after which the dashboard refreshes the run's state. */
export const RUN_EVENT_REFRESH: ReadonlySet<string> = new Set([
  'NodeStarted',
  'NodeCompleted',
  'NodeFailed',
  'NodeSuspended',
  'GatePassed',
  'GateFailed',
  'DecisionMade',
  'HumanRequested',
  'HumanResponded',
  'ToolApprovalRequested',
  'ToolApprovalResolved',
  'BudgetWarning',
  'BudgetExceeded',
  'RunResumed',
  'RunCompleted',
  'RunCancelled',
]);

/** A one-line summary of a tool input: its path or command when it has one, else trimmed JSON. */
export function summarizeInput(input: unknown, limit = SUMMARY_LIMIT): string {
  if (input === undefined) return '';
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const o = input as Record<string, unknown>;
    for (const key of ['file_path', 'command']) {
      const v = o[key];
      if (typeof v === 'string' && v) return v.length > limit ? v.slice(0, limit) : v;
    }
  }
  let s: string;
  try {
    s = JSON.stringify(input) ?? String(input);
  } catch {
    s = String(input);
  }
  return s.length > limit ? s.slice(0, limit) : s;
}

type Ev = Record<string, unknown> & { type: string; at?: string; nodeId?: string };

const TERMINAL: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);

/** Nodes of the snapshot in reading order: breadth-first from `start`, then the rest by key. */
function nodeOrder(state: RunState | undefined): string[] {
  const wf = state?.workflowSnapshot;
  if (!wf) return Object.keys(state?.nodes ?? {});
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [wf.start];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (seen.has(id) || !wf.nodes[id]) continue;
    seen.add(id);
    out.push(id);
    const node = wf.nodes[id] as WorkflowNode;
    const next: string[] =
      node.type === 'decide'
        ? Object.values(node.next)
        : node.type === 'gate'
          ? [node.on_pass, node.on_fail]
          : node.type === 'parallel'
            ? [...node.branches, node.join]
            : node.next
              ? [node.next]
              : [];
    queue.push(...next);
  }
  for (const id of Object.keys(wf.nodes)) if (!seen.has(id)) out.push(id);
  return out;
}

function newCard(state: RunState | undefined, nodeId: string): Card {
  const def = state?.workflowSnapshot?.nodes[nodeId] as WorkflowNode | undefined;
  const st = state?.nodes[nodeId];
  const status: NodeStatus = st?.status ?? 'pending';
  const attempts = st?.attempts ?? 0;
  switch (def?.type) {
    case 'gate':
      return {
        kind: 'gate',
        key: `card:${nodeId}`,
        nodeId,
        status,
        attempts,
        checks: st?.report?.checks.map(check) ?? [],
        passed: st?.report?.passed,
        report: st?.report ? failures(st.report.checks) : undefined,
      };
    case 'decide':
      return { kind: 'decide', key: `card:${nodeId}`, nodeId, status, choice: st?.choice };
    case 'human':
      return {
        kind: 'human',
        key: `card:${nodeId}`,
        nodeId,
        prompt: def.prompt ?? def.action,
        action: def.action,
        pending: state?.pendingHumans.some((p) => p.nodeId === nodeId) ?? false,
      };
    default:
      return {
        kind: 'node',
        key: `card:${nodeId}`,
        nodeId,
        type: def?.type === 'code' ? 'code' : 'task',
        role: def?.type === 'task' ? def.role : undefined,
        runtime: def?.type === 'task' ? state?.adapter : undefined,
        status,
        attempts,
        costUsd: undefined,
        blocks: [],
        tools: 0,
      };
  }
}

function check(c: { name: string; passed: boolean; evidence: string }) {
  return { name: c.name, passed: c.passed, message: c.evidence || undefined };
}

function failures(checks: { passed: boolean; evidence: string }[]): string | undefined {
  const lines = checks.filter((c) => !c.passed && c.evidence).map((c) => c.evidence);
  return lines.length > 0 ? lines.join('\n') : undefined;
}

/**
 * Folds the run's state and its SSE frames into the cards of the session view: one per node
 * in the order the nodes started, runtime frames inside their node's card, errors and the
 * summary as cards of their own. Without frames the cards come from the state alone.
 */
export function reduceTimeline(state: RunState | undefined, frames: Envelope[]): Card[] {
  const cards: Card[] = [];
  const byNode = new Map<string, Card>();
  const files = new Set<string>();
  let startedAt: string | undefined;
  let lastAt: string | undefined;
  let ended = false;

  const cardFor = (nodeId: string): Card => {
    let c = byNode.get(nodeId);
    if (!c) {
      c = newCard(state, nodeId);
      byNode.set(nodeId, c);
      cards.push(c);
    }
    return c;
  };
  const cost = (c: Card, ev: Ev) => {
    const usd = (ev.cost as { usd?: number } | undefined)?.usd;
    if (c.kind === 'node' && typeof usd === 'number') c.costUsd = (c.costUsd ?? 0) + usd;
  };
  const finish = (c: Card, ev: Ev, status: NodeStatus) => {
    if (c.kind === 'node') {
      c.endedAt = ev.at;
      if (!state?.nodes[c.nodeId]) c.status = status;
    } else if ((c.kind === 'gate' || c.kind === 'decide') && !state?.nodes[c.nodeId])
      c.status = status;
    cost(c, ev);
  };

  for (const frame of frames) {
    if (frame.kind === 'end') {
      ended = true;
      continue;
    }
    if (frame.kind === 'run') {
      const ev = frame.event as unknown as Ev;
      lastAt = ev.at ?? lastAt;
      switch (ev.type) {
        case 'RunStarted':
          startedAt = ev.at;
          break;
        case 'NodeStarted': {
          const c = cardFor(ev.nodeId as string);
          if ('attempts' in c && !state?.nodes[c.nodeId]) c.attempts += 1;
          if (c.kind === 'node') {
            c.startedAt = ev.at;
            if (!state?.nodes[c.nodeId]) c.status = 'running';
          }
          break;
        }
        case 'NodeCompleted':
          finish(cardFor(ev.nodeId as string), ev, 'completed');
          break;
        case 'NodeFailed':
          finish(cardFor(ev.nodeId as string), ev, 'failed');
          break;
        case 'GatePassed':
        case 'GateFailed': {
          const c = cardFor(ev.nodeId as string);
          const report = ev.report as {
            passed: boolean;
            checks: { name: string; passed: boolean; evidence: string }[];
          };
          if (c.kind === 'gate') {
            c.checks = report.checks.map(check);
            c.passed = report.passed;
            c.report = failures(report.checks);
          }
          finish(c, ev, ev.type === 'GatePassed' ? 'passed' : 'gate_failed');
          break;
        }
        case 'DecisionMade': {
          const c = cardFor(ev.nodeId as string);
          if (c.kind === 'decide') {
            c.choice = ev.choice as string;
            c.confidence = ev.confidence as number | undefined;
          }
          cost(c, ev);
          break;
        }
        case 'HumanRequested': {
          const c = cardFor(ev.nodeId as string);
          if (c.kind === 'human') {
            c.prompt = ev.prompt as string;
            c.action = ev.action as string;
          }
          break;
        }
        case 'HumanResponded': {
          const c = cardFor(ev.nodeId as string);
          if (c.kind === 'human') {
            c.answer = {
              approved: ev.approved as boolean,
              note: ev.note as string | undefined,
              at: ev.at ?? '',
            };
            c.pending = false;
          }
          break;
        }
        case 'RunCompleted':
        case 'RunCancelled':
          ended = true;
          break;
        default:
          break;
      }
      continue;
    }
    // runtime frame
    const env = frame.event;
    const c = cardFor(env.nodeId);
    const rt = env.event as Record<string, unknown> & { type: string };
    if (c.kind !== 'node') {
      if (rt.type === 'file_changed') files.add(rt.path as string);
      continue;
    }
    switch (rt.type) {
      case 'text': {
        const text = rt.text as string;
        const parentId = rt.parentToolUseId as string | undefined;
        const last = c.blocks.at(-1);
        const key = `text:${c.blocks.length}`;
        if (last?.kind === 'text' && last.parentId === parentId) last.text += text;
        else
          c.blocks.push(
            parentId ? { kind: 'text', key, text, parentId } : { kind: 'text', key, text },
          );
        break;
      }
      case 'tool_use': {
        const id = (rt.id as string | undefined) ?? `tool-${c.tools + 1}`;
        const parentId = rt.parentToolUseId as string | undefined;
        c.blocks.push({
          kind: 'tool',
          key: `tool:${id}`,
          id,
          name: rt.name as string,
          summary: summarizeInput(rt.input),
          input: rt.input,
          status: 'running',
          ...(parentId ? { parentId } : {}),
        });
        c.tools += 1;
        break;
      }
      case 'tool_result': {
        const id = rt.id as string | undefined;
        const block = [...c.blocks]
          .reverse()
          .find(
            (b): b is Block & { kind: 'tool' } =>
              b.kind === 'tool' &&
              (id ? b.id === id : b.name === rt.name && b.status === 'running'),
          );
        if (block) {
          block.output = rt.output;
          if (typeof rt.durationMs === 'number') block.ms = rt.durationMs;
          block.status = 'done';
        }
        break;
      }
      case 'file_changed':
        files.add(rt.path as string);
        c.blocks.push({ kind: 'file', key: `file:${c.blocks.length}`, path: rt.path as string });
        break;
      case 'error':
        cards.push({
          kind: 'error',
          key: `error:${cards.length}`,
          nodeId: env.nodeId,
          message: rt.message as string,
        });
        break;
      default:
        break;
    }
  }

  // nodes the state knows but no frame mentioned (no stream, or history already gone)
  if (state)
    for (const id of nodeOrder(state))
      if (state.nodes[id] && !byNode.has(id)) {
        const c = newCard(state, id);
        byNode.set(id, c);
        cards.push(c);
      }

  if (ended || (state && TERMINAL.has(state.status))) {
    const status: RunStatus = state?.status ?? 'completed';
    cards.push({
      kind: 'summary',
      key: 'summary',
      status,
      costUsd: state?.spentUsd ?? 0,
      durationMs:
        startedAt && lastAt ? Math.max(0, Date.parse(lastAt) - Date.parse(startedAt)) : undefined,
      files: [...files],
      branch: state?.branch,
      error: state?.error,
    });
  }

  if (cards.length > CARD_LIMIT) {
    const drop = cards.length - CARD_LIMIT;
    return [{ kind: 'earlier', key: 'earlier', count: drop }, ...cards.slice(drop)];
  }
  return cards;
}
