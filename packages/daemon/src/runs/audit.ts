import { isTerminal, type RunState, type StoredEvent } from '@wizardingcode/shibaox-core';
import type { CheckResult } from '@wizardingcode/shibaox-schemas';
import type { RuntimeEnvelope } from '../runtime-buffer.js';

/** One tool call of a task, as the audit shows it. */
export interface AuditToolCall {
  name: string;
  /** The input, JSON, clipped. */
  input: string;
  durationMs?: number;
  at: string;
}

export interface AuditNode {
  nodeId: string;
  /** From the workflow snapshot; absent for runs recorded before snapshots. */
  type?: string;
  role?: string;
  status: string;
  attempts: number;
  startedAt?: string;
  endedAt?: string;
  summary?: string;
  error?: string;
  choice?: string;
  costUsd: number;
  toolCalls: AuditToolCall[];
}

export interface AuditApproval {
  kind: 'human' | 'tool';
  nodeId: string;
  askedAt?: string;
  answeredAt?: string;
  /** The prompt of a human node, or the command of a tool approval. */
  what: string;
  approved?: boolean;
  via?: string;
  note?: string;
}

export interface AuditDoc {
  runId: string;
  workflow: string;
  status: string;
  request: {
    input: Record<string, unknown>;
    orgRoot?: string;
    project?: string;
    workspace: string;
    workspaceMode?: string;
    branch?: string;
    baseBranch?: string;
    adapter?: string;
    model?: string;
    origin?: string;
    parentRunId?: string;
    budgetUsd?: number;
  };
  createdAt: string;
  endedAt?: string;
  durationMs?: number;
  cost: { totalUsd: number; byNode: Record<string, number> };
  nodes: AuditNode[];
  gates: { nodeId: string; at: string; passed: boolean; checks: CheckResult[] }[];
  decisions: { nodeId: string; at: string; choice: string; confidence?: number }[];
  approvals: AuditApproval[];
  git: { nodeId: string; action?: string; at: string; output: unknown }[];
  error?: string;
}

/** The runtime event types the audit uses (texts and usage are left in the store). */
export const AUDIT_RUNTIME_TYPES = ['tool_use', 'tool_result'] as const;

const INPUT_LIMIT = 400;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const round = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * Everything that happened in a run, from its event log and its runtime events: the request,
 * every node with its attempts and tool calls, gates with evidence, decisions, who approved
 * what through which channel, what git did, and what it cost.
 */
export function buildAudit(
  state: RunState,
  events: StoredEvent[],
  runtime: RuntimeEnvelope[],
): AuditDoc {
  const created = events.find((e) => e.type === 'RunCreated');
  const last = events[events.length - 1];
  // a run that is over ended with its last event (a rejection ends it without a RunCancelled)
  const ended = last && isTerminal(state.status) ? last.at : undefined;
  const snapshotNodes = (state.workflowSnapshot?.nodes ?? {}) as Record<
    string,
    { type?: string; role?: string; action?: string }
  >;
  // nodes in the order they first started
  const order: string[] = [];
  for (const e of events)
    if (e.type === 'NodeStarted' && !order.includes(e.nodeId)) order.push(e.nodeId);
  for (const id of Object.keys(state.nodes)) if (!order.includes(id)) order.push(id);
  const byNode: Record<string, number> = {};
  for (const e of events) {
    const cost = 'cost' in e ? e.cost : undefined;
    const nodeId = 'nodeId' in e ? e.nodeId : undefined;
    if (cost && nodeId) byNode[nodeId] = round((byNode[nodeId] ?? 0) + cost.usd);
  }
  const toolCalls = new Map<string, AuditToolCall[]>();
  const open = new Map<string, AuditToolCall>();
  for (const r of runtime) {
    const ev = r.event;
    if (ev.type === 'tool_use') {
      const call: AuditToolCall = {
        name: ev.name,
        input: clip(
          typeof ev.input === 'string' ? ev.input : (JSON.stringify(ev.input) ?? ''),
          INPUT_LIMIT,
        ),
        at: r.at,
      };
      toolCalls.set(r.nodeId, [...(toolCalls.get(r.nodeId) ?? []), call]);
      open.set(ev.id ?? `${r.nodeId}:${ev.name}`, call);
    } else if (ev.type === 'tool_result') {
      const call = open.get(ev.id ?? `${r.nodeId}:${ev.name}`);
      if (call && ev.durationMs !== undefined) call.durationMs = ev.durationMs;
    }
  }
  const nodes: AuditNode[] = order.map((nodeId) => {
    const n = state.nodes[nodeId];
    const started = events.filter((e) => e.type === 'NodeStarted' && e.nodeId === nodeId);
    const finished = events.filter(
      (e) =>
        'nodeId' in e &&
        e.nodeId === nodeId &&
        (e.type === 'NodeCompleted' ||
          e.type === 'NodeFailed' ||
          e.type === 'NodeSuspended' ||
          e.type === 'HumanResponded'),
    );
    const snap = snapshotNodes[nodeId];
    return {
      nodeId,
      type: snap?.type,
      role: snap?.role,
      status: n?.status ?? 'pending',
      attempts: n?.attempts ?? started.length,
      startedAt: started[0]?.at,
      endedAt: finished[finished.length - 1]?.at,
      summary: n?.summary || undefined,
      error: n?.error,
      choice: n?.choice,
      costUsd: byNode[nodeId] ?? 0,
      toolCalls: toolCalls.get(nodeId) ?? [],
    };
  });
  const gates = events.flatMap((e) =>
    e.type === 'GatePassed' || e.type === 'GateFailed'
      ? [{ nodeId: e.nodeId, at: e.at, passed: e.report.passed, checks: e.report.checks }]
      : [],
  );
  const decisions = events.flatMap((e) =>
    e.type === 'DecisionMade'
      ? [
          {
            nodeId: e.nodeId,
            at: e.at,
            choice: e.choice,
            ...(e.confidence !== undefined ? { confidence: e.confidence } : {}),
          },
        ]
      : [],
  );
  const approvals: AuditApproval[] = [];
  const tools = new Map<string, AuditApproval>();
  for (const e of events) {
    if (e.type === 'ToolApprovalRequested') {
      const a: AuditApproval = { kind: 'tool', nodeId: e.nodeId, askedAt: e.at, what: e.command };
      approvals.push(a);
      tools.set(e.approvalId, a);
    } else if (e.type === 'ToolApprovalResolved') {
      const a = tools.get(e.approvalId);
      if (a)
        Object.assign(a, {
          answeredAt: e.at,
          approved: e.approved,
          via: e.via,
          ...(e.note ? { note: e.note } : {}),
        });
    } else if (e.type === 'HumanRequested')
      approvals.push({ kind: 'human', nodeId: e.nodeId, askedAt: e.at, what: e.prompt });
    else if (e.type === 'HumanResponded') {
      const a = approvals.find(
        (x) => x.kind === 'human' && x.answeredAt === undefined && x.nodeId === e.nodeId,
      );
      if (a)
        Object.assign(a, {
          answeredAt: e.at,
          approved: e.approved,
          ...(e.via ? { via: e.via } : {}),
          ...(e.note ? { note: e.note } : {}),
        });
    }
  }
  const git = events.flatMap((e) =>
    e.type === 'NodeCompleted' && snapshotNodes[e.nodeId]?.type === 'git'
      ? [{ nodeId: e.nodeId, action: snapshotNodes[e.nodeId]?.action, at: e.at, output: e.output }]
      : [],
  );
  const createdAt = created?.at ?? events[0]?.at ?? '';
  return {
    runId: state.runId,
    workflow: state.workflow,
    status: state.status,
    request: {
      input: state.input,
      orgRoot: state.orgRoot,
      project: state.project,
      workspace: state.workspace,
      workspaceMode: state.workspaceMode,
      branch: state.branch,
      baseBranch: state.baseBranch,
      adapter: state.adapter,
      model: state.model,
      origin: state.origin,
      parentRunId: state.parentRunId,
      budgetUsd: state.budgetUsd,
    },
    createdAt,
    endedAt: ended,
    durationMs: ended ? Date.parse(ended) - Date.parse(createdAt) : undefined,
    cost: { totalUsd: round(state.spentUsd), byNode },
    nodes,
    gates,
    decisions,
    approvals,
    git,
    error: state.error,
  };
}

const money = (n: number) => `$${n.toFixed(4)}`;
/** One line, no table pipes: for cells and list items. */
const inline = (s: string) =>
  s
    .replace(/\|/g, '\\|')
    .replace(/\s*\n\s*/g, ' ')
    .trim();
/** A block of the run's own text: lines that would read as headings are escaped. */
const block = (s: string) => s.replace(/^(\s*)(#)/gm, '$1\\$2');
/** A fence longer than any backtick run inside the text. */
const fence = (s: string) => {
  const longest = Math.max(2, ...[...s.matchAll(/`+/g)].map((m) => m[0].length));
  return '`'.repeat(longest + 1);
};
const duration = (ms: number) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
};
const requestText = (input: Record<string, unknown>) =>
  typeof input.spec === 'string' ? input.spec : JSON.stringify(input);

/** The audit as a Markdown document: for a review, a ticket, a compliance file. */
export function renderAuditMarkdown(doc: AuditDoc): string {
  const out: string[] = [];
  out.push(`# Run ${doc.runId} · ${doc.workflow} · ${doc.status}`, '');
  out.push(`- Started: ${doc.createdAt}`);
  if (doc.endedAt)
    out.push(
      `- Ended: ${doc.endedAt}${doc.durationMs !== undefined ? ` (${duration(doc.durationMs)})` : ''}`,
    );
  out.push(
    `- Cost: ${money(doc.cost.totalUsd)}${doc.request.budgetUsd !== undefined ? ` of ${money(doc.request.budgetUsd)}` : ''}`,
  );
  if (doc.error) out.push(`- Error: ${inline(doc.error)}`);
  out.push('', '## Request', '', block(requestText(doc.request.input)), '');
  const r = doc.request;
  const facts: [string, string | undefined][] = [
    ['Org', r.orgRoot],
    ['Project', r.project],
    ['Workspace', `${r.workspace}${r.workspaceMode ? ` (${r.workspaceMode})` : ''}`],
    ['Branch', r.branch],
    ['Base branch', r.baseBranch],
    ['Adapter', r.adapter],
    ['Model', r.model],
    ['Origin', r.origin],
    ['Parent run', r.parentRunId],
  ];
  for (const [k, v] of facts) if (v) out.push(`- ${k}: ${v}`);
  out.push('', '## Nodes', '');
  for (const n of doc.nodes) {
    const head = [n.nodeId, n.type, n.role ? `role ${n.role}` : undefined, n.status]
      .filter(Boolean)
      .join(' · ');
    out.push(`### ${head}`, '');
    const line: string[] = [`attempts ${n.attempts}`];
    if (n.startedAt) line.push(`started ${n.startedAt}`);
    if (n.endedAt) line.push(`ended ${n.endedAt}`);
    if (n.costUsd) line.push(money(n.costUsd));
    out.push(`- ${line.join(' · ')}`);
    if (n.summary) out.push(`- Summary: ${inline(n.summary)}`);
    if (n.choice) out.push(`- Choice: ${inline(n.choice)}`);
    if (n.error) out.push(`- Error: ${inline(n.error)}`);
    if (n.toolCalls.length) {
      out.push('', '| Tool | Input | Duration |', '| --- | --- | --- |');
      for (const c of n.toolCalls)
        out.push(
          `| ${inline(c.name)} | ${inline(c.input)} | ${c.durationMs !== undefined ? `${c.durationMs} ms` : ''} |`,
        );
    }
    out.push('');
  }
  if (doc.gates.length) {
    out.push('## Gates', '');
    for (const g of doc.gates) {
      out.push(`### ${g.nodeId} · ${g.passed ? 'passed' : 'failed'} · ${g.at}`, '');
      for (const c of g.checks) {
        out.push(
          `- ${c.name} (${c.type}): ${c.skipped ? 'skipped' : c.passed ? 'passed' : 'failed'}${c.confidence !== undefined ? ` (${c.confidence.toFixed(2)})` : ''}`,
        );
        if (c.evidence) {
          const f = fence(c.evidence);
          out.push(
            '',
            `  ${f}`,
            ...clip(c.evidence, 1500)
              .split('\n')
              .map((l) => `  ${l}`),
            `  ${f}`,
            '',
          );
        }
      }
    }
  }
  if (doc.decisions.length) {
    out.push('## Decisions', '');
    for (const d of doc.decisions)
      out.push(
        `- ${d.nodeId}: ${d.choice}${d.confidence !== undefined ? ` (${d.confidence.toFixed(2)})` : ''} · ${d.at}`,
      );
    out.push('');
  }
  if (doc.approvals.length) {
    out.push('## Approvals', '');
    for (const a of doc.approvals) {
      const verdict =
        a.approved === undefined
          ? 'unanswered'
          : `${a.approved ? 'approved' : 'denied'}${a.via ? ` via ${a.via}` : ''}`;
      out.push(
        `- ${a.nodeId} (${a.kind}): ${a.what} → ${verdict}${a.note ? ` — "${a.note}"` : ''}${a.answeredAt ? ` · ${a.answeredAt}` : ''}`,
      );
    }
    out.push('');
  }
  if (doc.git.length) {
    out.push('## Git', '');
    for (const g of doc.git)
      out.push(
        `- ${g.nodeId}${g.action ? ` (${g.action})` : ''}: ${JSON.stringify(g.output)} · ${g.at}`,
      );
    out.push('');
  }
  return `${out.join('\n').trimEnd()}\n`;
}
