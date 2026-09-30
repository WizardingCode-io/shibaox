import { z } from 'zod';
import { Id } from './common.js';

export const TaskNodeSchema = z.object({
  type: z.literal('task'),
  role: Id,
  instruction: z.string().optional(),
  next: Id.optional(),
});
export const CodeNodeSchema = z.object({
  type: z.literal('code'),
  command: z.string().min(1),
  timeout_ms: z.number().int().positive().default(300_000),
  /** When the program is not installed (exit 127), complete with a note instead of failing the run. */
  skip_if_missing: z.boolean().default(false),
  /** Exit codes that count as done (an audit that found something exits 1 and still has a report). */
  ok_exit_codes: z.array(z.number().int().min(0).max(255)).min(1).default([0]),
  next: Id.optional(),
});
export const HumanNodeSchema = z.object({
  type: z.literal('human'),
  action: Id,
  prompt: z.string().optional(),
  next: Id.optional(),
});
export const DecideNodeSchema = z.object({
  type: z.literal('decide'),
  by: Id,
  question: z.string().optional(),
  options: z.array(Id).min(2),
  next: z.record(z.string(), Id),
});
export const GateNodeSchema = z.object({
  type: z.literal('gate'),
  gates: z.array(Id).min(1),
  on_pass: Id,
  on_fail: Id,
  max_retries: z.number().int().min(0).default(3),
});
/**
 * A git step the daemon runs itself (trusted org config, like `code`): `commit` the workspace,
 * open a `pr` (push + `gh pr create`), or `merge` the run branch on the base through the
 * project's merge queue (rebase, tests, fast-forward, push when there is a remote).
 */
export const GitNodeSchema = z.object({
  type: z.literal('git'),
  /**
   * `commit`, `pr`, `merge` (the run branch on the base, locally); `review` and `comment`
   * publish a node's text on the pull request; `merge_pr` merges it through GitHub.
   */
  action: z.enum(['commit', 'pr', 'merge', 'review', 'comment', 'merge_pr']),
  /** Commit message / PR body / comment text; generated or taken from `from` when absent. */
  message: z.string().optional(),
  /** review, comment: the node whose text is published. */
  from: Id.optional(),
  /** review: the review event (default `comment`). */
  event: z.enum(['approve', 'request-changes', 'comment']).optional(),
  /** merge_pr: how GitHub merges (default `squash`). */
  method: z.enum(['squash', 'merge', 'rebase']).optional(),
  /** Base branch for `pr` and `merge` (default: the repository's default branch, else main). */
  base: z.string().optional(),
  /** Test command run before a merge (default: detected from the workspace; none skips). */
  tests: z.string().optional(),
  timeout_ms: z.number().int().positive().default(600_000),
  next: Id.optional(),
});
export const ParallelNodeSchema = z.object({
  type: z.literal('parallel'),
  branches: z.array(Id).min(1),
  join: Id,
});

export const WorkflowNodeSchema = z.discriminatedUnion('type', [
  TaskNodeSchema,
  CodeNodeSchema,
  HumanNodeSchema,
  DecideNodeSchema,
  GateNodeSchema,
  GitNodeSchema,
  ParallelNodeSchema,
]);
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;

export function transitionsOf(node: WorkflowNode): string[] {
  switch (node.type) {
    case 'task':
    case 'code':
    case 'human':
    case 'git':
      return node.next ? [node.next] : [];
    case 'decide':
      return Object.values(node.next);
    case 'gate':
      return [node.on_pass, node.on_fail];
    case 'parallel':
      return [...node.branches, node.join];
  }
}

export const WorkflowSchema = z
  .object({
    workflow: Id,
    team: Id.optional(),
    description: z.string().optional(),
    /** A conversation with the orchestrator: runs in place and reads as messages in the dashboard. */
    conversation: z.boolean().optional(),
    /** `false`: the team's gates are not injected before this workflow's terminal nodes. */
    team_gates: z.boolean().optional(),
    start: Id,
    nodes: z.record(z.string(), WorkflowNodeSchema),
  })
  .superRefine((wf, ctx) => {
    const ids = new Set(Object.keys(wf.nodes));
    if (!ids.has(wf.start)) {
      ctx.addIssue({
        code: 'custom',
        path: ['start'],
        message: `start node "${wf.start}" does not exist`,
      });
    }
    for (const [id, node] of Object.entries(wf.nodes)) {
      for (const target of transitionsOf(node)) {
        if (!ids.has(target)) {
          ctx.addIssue({
            code: 'custom',
            path: ['nodes', id],
            message: `node "${id}" points to unknown node "${target}"`,
          });
        }
      }
      if (node.type === 'decide') {
        for (const opt of node.options) {
          if (!(opt in node.next)) {
            ctx.addIssue({
              code: 'custom',
              path: ['nodes', id, 'next'],
              message: `decide "${id}" has no transition for option "${opt}"`,
            });
          }
        }
        for (const key of Object.keys(node.next)) {
          if (!node.options.includes(key)) {
            ctx.addIssue({
              code: 'custom',
              path: ['nodes', id, 'next'],
              message: `decide "${id}" transition "${key}" is not an option`,
            });
          }
        }
      }
    }
  });
export type Workflow = z.infer<typeof WorkflowSchema>;
