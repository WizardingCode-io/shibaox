import { createHash } from 'node:crypto';
import type { ApprovalCategory } from './command-policy.js';

/**
 * A command (tool `Bash`) or a file write (tool `file`, program `write`, argv `['write', path]`)
 * an adapter wants to do for a role with `approval_required`.
 */
export interface ApprovalRequest {
  runId: string;
  nodeId: string;
  role: string;
  tool: 'Bash' | 'file';
  program: string;
  category: ApprovalCategory;
  command: string;
  argv: string[];
}

/**
 * The human's answer, or `deferred` when nobody answered in time: the adapter then stops the
 * task with `approval_pending` and the run waits for the inbox (see the daemon).
 */
export type ApprovalAnswer =
  | { approved: boolean; note?: string }
  | { deferred: true; approvalId: string };

export interface ApprovalHandler {
  request(req: ApprovalRequest, opts: { signal?: AbortSignal }): Promise<ApprovalAnswer>;
}

/** Identifies the exact command an approval was given for. */
export const argvHash = (argv: string[]): string =>
  createHash('sha256').update(JSON.stringify(argv)).digest('hex');

export class AutoApproveApprovals implements ApprovalHandler {
  async request(): Promise<ApprovalAnswer> {
    return { approved: true, note: 'auto-approved' };
  }
}

export class DenyApprovals implements ApprovalHandler {
  async request(): Promise<ApprovalAnswer> {
    return { approved: false, note: 'approvals are disabled' };
  }
}
