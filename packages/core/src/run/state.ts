import type { GateReport, Workflow } from '@shibaox/schemas';

export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting_human'
  | 'waiting_approval'
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

export interface NodeApproval {
  argvHash: string;
  command: string;
  /** Absent while the approval is pending. */
  approved?: boolean;
  note?: string;
}

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
  /** Runtime session of the latest attempt (Claude Code `session_id`), for resume. */
  sessionId?: string;
  /** Tool approvals asked during this node, by approvalId. */
  approvals: Record<string, NodeApproval>;
}

export interface PendingApproval {
  approvalId: string;
  runId: string;
  nodeId: string;
  role: string;
  tool: 'Bash';
  program: string;
  category: 'push' | 'deploy';
  command: string;
  argvHash: string;
  at: string;
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
  adapter?: string;
  workspaceMode?: 'inplace' | 'worktree';
  /** Main checkout of the project (recorded since phase 1B-2; absent in older runs). */
  project?: string;
  /** Worktree branch of a `worktree` run (recorded since phase 1B-2). */
  branch?: string;
  /** The org directory the run was submitted with (recorded since phase 2A). */
  orgRoot?: string;
  status: RunStatus;
  nodes: Record<string, NodeState>;
  spentUsd: number;
  budgetUsd?: number;
  budgetWarned: boolean;
  pendingHumans: PendingHuman[];
  pendingApprovals: PendingApproval[];
  lastGateReport?: GateReport;
  error?: string;
}
