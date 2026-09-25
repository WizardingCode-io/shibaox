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
  ParallelNodeSchema,
]);
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;

export function transitionsOf(node: WorkflowNode): string[] {
  switch (node.type) {
    case 'task':
    case 'code':
    case 'human':
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
