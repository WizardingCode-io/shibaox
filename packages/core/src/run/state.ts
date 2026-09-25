import type { GateReport, Workflow } from '@shibaox/schemas';

export type RunStatus =
  | 'running'
  | 'waiting_human'
  | 'paused_budget'
  | 'completed'
  | 'failed'
  | 'cancelled';
export type NodeStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'passed'
  | 'gate_failed'
  | 'failed'
  | 'waiting';

export interface NodeState {
  status: NodeStatus;
  attempts: number;
  output?: unknown;
  summary?: string;
  choice?: string;
  report?: GateReport;
  error?: string;
  /** Index (0-based) in the replayed event log of the latest NodeStarted. */
  startedIdx?: number;
  /** Index (0-based) in the replayed event log of the latest finishing event. */
  finishedIdx?: number;
}

export interface PendingHuman {
  nodeId: string;
  action: string;
  prompt: string;
}

export interface RunState {
  runId: string;
  workflow: string;
  workflowSnapshot?: Workflow;
  input: Record<string, unknown>;
  workspace: string;
  status: RunStatus;
  nodes: Record<string, NodeState>;
  spentUsd: number;
  budgetUsd?: number;
  budgetWarned: boolean;
  pendingHumans: PendingHuman[];
  lastGateReport?: GateReport;
  error?: string;
}
