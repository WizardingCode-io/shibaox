import { type AgentTool, isEventTurn, type RunState } from '@wizardingcode/shibaox-core';
import type { MemoryNotes } from '@wizardingcode/shibaox-memory';
import type { Role } from '@wizardingcode/shibaox-schemas';
import { z } from 'zod';
import type { RunSummaryPlus } from '../run-manager.js';

export interface OrchestrationArgs {
  runId: string;
  /** The workflow this run executes (never offered to itself). */
  current: string;
  workflows: { name: string; description?: string }[];
  startWorkflow: (
    workflow: string,
    request: string,
    o?: { outputSchema?: Record<string, unknown> },
  ) => Promise<{ runId: string }>;
  /** The runs this run dispatched. */
  listRuns?: () => Promise<RunSummaryPlus[]>;
  runStatus?: (runId: string) => Promise<RunState>;
  steerRun?: (runId: string, note: string) => Promise<{ ok: true }>;
  cancelRun?: (runId: string) => Promise<{ ok: true }>;
}

/** `start_workflow`: dispatches an org workflow as a child run of the orchestrator's run. */
export function orchestrationTools(a: OrchestrationArgs): AgentTool[] {
  const available = a.workflows.filter((w) => w.name !== a.current);
  const names = available.map((w) => w.name);
  const list = available
    .map((w) => `${w.name}${w.description ? ` — ${w.description}` : ''}`)
    .join('; ');
  /** An error when `id` is not a run this run dispatched; undefined when it is. */
  /** The runs this run dispatched (whatever the daemon lists, only its own children count). */
  const children = async () =>
    ((await a.listRuns?.()) ?? []).filter((r) => r.parentRunId === a.runId);
  const mine = async (id: string): Promise<{ error: string } | undefined> => {
    const runs = await children();
    if (!runs.some((r) => r.runId === id))
      return { error: `${id} is not one of your runs (list_runs shows them)` };
    return undefined;
  };
  return [
    {
      name: 'start_workflow',
      description: `Dispatch a workflow of this organisation (a team) on the current project as a run of its own; it starts queued and reports back in this conversation when it ends. Use it for larger work (a feature with tests, a review, several parts). Available: ${list || 'none'}`,
      input: z.object({
        workflow: z.string().describe('the workflow name'),
        request: z.string().describe('what the team should do, in full'),
        output_schema: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('a JSON Schema (object) the run must answer in; its last task is held to it'),
      }),
      execute: async (input) => {
        const workflow = String(input.workflow ?? '');
        const request = String(input.request ?? '');
        if (!names.includes(workflow))
          return {
            error: `workflow "${workflow}" is not defined in the org (available: ${names.join(', ') || 'none'})`,
          };
        if (!request.trim()) return { error: 'request is empty' };
        const schema = input.output_schema;
        if (
          schema !== undefined &&
          (typeof schema !== 'object' || schema === null || Array.isArray(schema))
        )
          return { error: 'output_schema must be a JSON Schema object' };
        try {
          const { runId } = await a.startWorkflow(workflow, request, {
            outputSchema: schema as Record<string, unknown> | undefined,
          });
          return { runId, workflow, status: 'queued' };
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) };
        }
      },
    },
    {
      name: 'list_runs',
      description: 'The runs you dispatched with start_workflow: id, workflow, status, spend.',
      input: z.object({}),
      execute: async () => {
        const runs = await children();
        return {
          runs: runs.map((r) => ({
            runId: r.runId,
            workflow: r.workflow,
            status: r.status,
            spentUsd: r.spentUsd,
            updatedAt: r.updatedAt,
          })),
        };
      },
    },
    {
      name: 'run_status',
      description:
        'Where one of your dispatched runs is: its status, each node and what it waits for.',
      input: z.object({ runId: z.string() }),
      execute: async (input) => {
        const id = String(input.runId ?? '');
        const own = await mine(id);
        if (own) return own;
        try {
          const st = await a.runStatus?.(id);
          if (!st) return { error: 'run_status is not available here' };
          return {
            runId: st.runId,
            status: st.status,
            spentUsd: st.spentUsd,
            error: st.error,
            needs: [
              ...st.pendingHumans.map((h) => `human: ${h.prompt}`),
              ...st.pendingApprovals.map((p) => `approval: ${p.command}`),
            ],
            nodes: Object.entries(st.nodes).map(([nodeId, n]) => ({
              nodeId,
              status: n.status,
              attempts: n.attempts,
              summary: n.summary,
              error: n.error,
            })),
          };
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) };
        }
      },
    },
    {
      name: 'steer_run',
      description:
        'Tell the running task of one of your dispatched runs something: it stops and starts again with the note. A correction of course, not a new request.',
      input: z.object({ runId: z.string(), note: z.string() }),
      execute: async (input) => {
        const id = String(input.runId ?? '');
        const note = String(input.note ?? '').trim();
        if (!note) return { error: 'the note is empty' };
        const own = await mine(id);
        if (own) return own;
        try {
          return (await a.steerRun?.(id, note)) ?? { error: 'steer_run is not available here' };
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) };
        }
      },
    },
    {
      name: 'cancel_run',
      description: 'Cancel one of your dispatched runs.',
      input: z.object({ runId: z.string() }),
      execute: async (input) => {
        const id = String(input.runId ?? '');
        const own = await mine(id);
        if (own) return own;
        try {
          return (await a.cancelRun?.(id)) ?? { error: 'cancel_run is not available here' };
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) };
        }
      },
    },
  ];
}

/** `remember` / `recall` over the org vault's memory notes. */
export function memoryTools(notes: MemoryNotes): AgentTool[] {
  return [
    {
      name: 'remember',
      description:
        'Save something worth remembering across conversations: scope "user" for preferences and facts about the user, "project" for decisions and conventions of this project.',
      input: z.object({ scope: z.string(), text: z.string() }),
      execute: async (input) => {
        const scope = input.scope;
        if (scope !== 'user' && scope !== 'project')
          return { error: 'scope must be "user" or "project"' };
        try {
          notes.remember(scope, String(input.text ?? ''));
          return { ok: true, scope };
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) };
        }
      },
    },
    {
      name: 'recall',
      description: 'Look up what was remembered (user and project notes) by words of a query.',
      input: z.object({ query: z.string() }),
      execute: async (input) => ({ matches: notes.recall(String(input.query ?? '')) }),
    },
  ];
}

/**
 * The daemon tools a task gets: `start_workflow` for the `orchestrate` capability, except on
 * event turns (a dispatched run reporting back must never dispatch again on its own), and the
 * memory tools for the `memory` capability.
 */
export function toolsForRole(
  role: Role,
  input: Record<string, unknown>,
  tools: { orchestration: AgentTool[]; memory: AgentTool[] },
): AgentTool[] {
  const out: AgentTool[] = [];
  if (role.capabilities.includes('orchestrate') && !isEventTurn(input))
    out.push(...tools.orchestration);
  if (role.capabilities.includes('memory')) out.push(...tools.memory);
  return out;
}
