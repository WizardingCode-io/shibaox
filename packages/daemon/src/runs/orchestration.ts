import { type AgentTool, isEventTurn } from '@shibaox/core';
import type { MemoryNotes } from '@shibaox/memory';
import type { Role } from '@shibaox/schemas';
import { z } from 'zod';

export interface OrchestrationArgs {
  runId: string;
  /** The workflow of the run holding the tool (never dispatched from itself). */
  current: string;
  workflows: { name: string; description?: string }[];
  startWorkflow(workflow: string, request: string): Promise<{ runId: string }>;
}

/** `start_workflow`: dispatches an org workflow as a child run of the orchestrator's run. */
export function orchestrationTools(a: OrchestrationArgs): AgentTool[] {
  const available = a.workflows.filter((w) => w.name !== a.current);
  const names = available.map((w) => w.name);
  const list = available
    .map((w) => `${w.name}${w.description ? ` — ${w.description}` : ''}`)
    .join('; ');
  return [
    {
      name: 'start_workflow',
      description: `Dispatch a workflow of this organisation (a team) on the current project as a run of its own; it starts queued and reports back in this conversation when it ends. Use it for larger work (a feature with tests, a review, several parts). Available: ${list || 'none'}`,
      input: z.object({
        workflow: z.string().describe('the workflow name'),
        request: z.string().describe('what the team should do, in full'),
      }),
      execute: async (input) => {
        const workflow = String(input.workflow ?? '');
        const request = String(input.request ?? '');
        if (!names.includes(workflow))
          return {
            error: `workflow "${workflow}" is not defined in the org (available: ${names.join(', ') || 'none'})`,
          };
        if (!request.trim()) return { error: 'request is empty' };
        try {
          const { runId } = await a.startWorkflow(workflow, request);
          return { runId, workflow, status: 'queued' };
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
