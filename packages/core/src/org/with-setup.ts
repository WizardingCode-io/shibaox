import type { Workflow } from '@wizardingcode/shibaox-schemas';

/**
 * The workflow with a `setup` step first: a `code` node that installs the project's
 * dependencies in a fresh worktree, so tests and linters run for real. A workflow that
 * already has a `setup` node handles it itself and is returned as is.
 */
export function withSetup(workflow: Workflow, command: string, timeoutMs: number): Workflow {
  if (workflow.nodes.setup) return workflow;
  return {
    ...workflow,
    start: 'setup',
    nodes: {
      setup: { type: 'code', command, timeout_ms: timeoutMs, next: workflow.start },
      ...workflow.nodes,
    },
  };
}
