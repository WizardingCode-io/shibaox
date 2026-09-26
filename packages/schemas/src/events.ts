import { z } from 'zod';
import { WorkflowSchema } from './workflow.js';

export const CostSchema = z.object({
  usd: z.number().min(0),
  inputTokens: z.number().int().min(0).default(0),
  outputTokens: z.number().int().min(0).default(0),
});
export type Cost = z.infer<typeof CostSchema>;

export const CheckResultSchema = z.object({
  name: z.string(),
  type: z.enum(['code', 'jev', 'judge', 'human', 'mock']),
  passed: z.boolean(),
  skipped: z.boolean().default(false),
  evidence: z.string(),
  suggestion: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  cost: CostSchema.optional(),
});
export type CheckResult = z.infer<typeof CheckResultSchema>;

export const GateReportSchema = z.object({
  gates: z.array(z.string()),
  passed: z.boolean(),
  checks: z.array(CheckResultSchema),
  cost: CostSchema.optional(),
});
export type GateReport = z.infer<typeof GateReportSchema>;

const base = { runId: z.string(), at: z.string() };
const node = { ...base, nodeId: z.string() };

export const RunEventSchema = z.discriminatedUnion('type', [
  z.object({
    ...base,
    type: z.literal('RunCreated'),
    workflow: z.string(),
    input: z.record(z.string(), z.unknown()),
    budgetUsd: z.number().positive().optional(),
    workspace: z.string(),
    workflowSnapshot: WorkflowSchema.optional(),
    adapter: z.string().optional(),
    workspaceMode: z.enum(['inplace', 'worktree']).optional(),
    /** The main checkout the run was started for (the worktree's source for `worktree` runs). */
    project: z.string().optional(),
    /** The run's worktree branch (`worktree` runs only). */
    branch: z.string().optional(),
    /** The org directory the run was submitted with (recorded since phase 2A). */
    orgRoot: z.string().optional(),
  }),
  z.object({ ...base, type: z.literal('RunStarted') }),
  z.object({
    ...node,
    type: z.literal('SessionStarted'),
    runtime: z.string(),
    sessionId: z.string(),
  }),
  z.object({
    ...node,
    type: z.literal('ToolApprovalRequested'),
    approvalId: z.string(),
    role: z.string(),
    tool: z.literal('Bash'),
    program: z.string(),
    category: z.enum(['push', 'deploy']),
    command: z.string(),
    argvHash: z.string(),
  }),
  z.object({
    ...node,
    type: z.literal('ToolApprovalResolved'),
    approvalId: z.string(),
    approved: z.boolean(),
    note: z.string().optional(),
    via: z.enum(['cli', 'telegram', 'api', 'auto']),
  }),
  z.object({
    ...node,
    type: z.literal('NodeSuspended'),
    sessionId: z.string().optional(),
    approvalId: z.string(),
    /** What the suspended attempt cost (counted by the reducer like any other cost). */
    cost: CostSchema.optional(),
  }),
  z.object({ ...node, type: z.literal('NodeStarted') }),
  z.object({
    ...node,
    type: z.literal('NodeCompleted'),
    output: z.unknown(),
    summary: z.string().default(''),
    cost: CostSchema.optional(),
  }),
  z.object({
    ...node,
    type: z.literal('NodeFailed'),
    error: z.string(),
    cost: CostSchema.optional(),
  }),
  z.object({
    ...node,
    type: z.literal('GatePassed'),
    report: GateReportSchema,
    cost: CostSchema.optional(),
  }),
  z.object({
    ...node,
    type: z.literal('GateFailed'),
    report: GateReportSchema,
    rework: z.string(),
    cost: CostSchema.optional(),
  }),
  z.object({
    ...node,
    type: z.literal('DecisionMade'),
    choice: z.string(),
    confidence: z.number().min(0).max(1).optional(),
    cost: CostSchema.optional(),
  }),
  z.object({ ...node, type: z.literal('HumanRequested'), action: z.string(), prompt: z.string() }),
  z.object({
    ...node,
    type: z.literal('HumanResponded'),
    approved: z.boolean(),
    note: z.string().optional(),
  }),
  z.object({
    ...base,
    type: z.literal('BudgetWarning'),
    spentUsd: z.number(),
    limitUsd: z.number(),
  }),
  z.object({
    ...base,
    type: z.literal('BudgetExceeded'),
    spentUsd: z.number(),
    limitUsd: z.number(),
    /** The task stopped by its runtime's budget cap; it goes back to pending and re-runs on resume. */
    nodeId: z.string().optional(),
    /** What that stopped attempt cost. */
    cost: CostSchema.optional(),
  }),
  z.object({ ...base, type: z.literal('RunResumed'), budgetUsd: z.number().positive().optional() }),
  z.object({ ...base, type: z.literal('RunCompleted') }),
  z.object({ ...base, type: z.literal('RunCancelled'), reason: z.string() }),
]);
export type RunEvent = z.infer<typeof RunEventSchema>;
