import type { Cost, GateReport } from '@shibaox/schemas';

export interface DecisionRequest {
  runId: string;
  nodeId: string;
  by: string;
  question: string;
  options: string[];
  context: {
    input: Record<string, unknown>;
    previousOutputs: Record<string, unknown>;
    lastGateReport?: GateReport;
  };
  /** The run's abort signal; deciders that call models should forward it. */
  signal?: AbortSignal;
}
export interface Decision {
  choice: string;
  confidence?: number;
  cost?: Cost;
}
export interface Decider {
  decide(req: DecisionRequest): Promise<Decision>;
}

export class ScriptedDecider implements Decider {
  constructor(
    private readonly choices: Record<string, string>,
    private readonly fallback?: string,
  ) {}
  async decide(req: DecisionRequest): Promise<Decision> {
    const choice = this.choices[req.nodeId] ?? this.fallback ?? req.options[0];
    if (!choice) throw new Error(`no scripted choice for node ${req.nodeId}`);
    return { choice, confidence: 1 };
  }
}

export interface HumanRequest {
  runId: string;
  nodeId: string;
  action: string;
  prompt: string;
}
export type HumanAnswer = { approved: boolean; note?: string } | { deferred: true };
export interface HumanHandler {
  ask(req: HumanRequest): Promise<HumanAnswer>;
}
export class AutoApproveHuman implements HumanHandler {
  async ask(): Promise<HumanAnswer> {
    return { approved: true, note: 'auto-approved' };
  }
}
export class DeferHuman implements HumanHandler {
  async ask(): Promise<HumanAnswer> {
    return { deferred: true };
  }
}
