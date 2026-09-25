import type { GateReport } from '@shibaox/schemas';

export type RunStatus =
  | 'running'
  | 'waiting_human'
  | 'paused_budget'
  | 'completed'
  | 'failed'
  | 'cancelled';
export type NodeStatus = 'pending' | 'running' | 'completed' | 'passed' | 'failed' | 'waiting';

export interface NodeState {
  status: NodeStatus;
  attempts: number;
  output?: unknown;
  summary?: string;
  choice?: string;
  report?: GateReport;
  error?: string;
}

export interface RunState {
  runId: string;
  workflow: string;
  input: Record<string, unknown>;
  workspace: string;
  status: RunStatus;
  nodes: Record<string, NodeState>;
  spentUsd: number;
  budgetUsd?: number;
  budgetWarned: boolean;
  pendingHuman?: { nodeId: string; action: string; prompt: string };
  lastGateReport?: GateReport;
  error?: string;
}
