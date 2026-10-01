import { choice } from '@typesafe-ai/sdk';
import type { Decider, Decision, DecisionRequest } from '@wizardingcode/shibaox-core';
import { addCost, gateByConfidence, type JevClient, truncateState } from './client.js';

export class JevDecider implements Decider {
  constructor(
    private readonly client: JevClient,
    private readonly opts: { threshold?: number; fallback?: Decider } = {},
  ) {}
  async decide(req: DecisionRequest): Promise<Decision> {
    const criteria = Object.fromEntries(req.options.map((o) => [o, o]));
    const spec = `${req.question}\n${JSON.stringify(req.context.input)}`;
    const output = JSON.stringify(req.context.previousOutputs);
    const diff = req.context.lastGateReport
      ? JSON.stringify(req.context.lastGateReport)
      : undefined;
    const state = truncateState({ spec, output, diff });
    const r = await this.client.fanOut(
      state,
      { decision: choice(req.question || 'Choose the next step', criteria) },
      { signal: req.signal },
    );
    const a = r.answers.decision;
    const cost = {
      usd: r.cost,
      inputTokens: r.usage.inputTokens,
      outputTokens: r.usage.outputTokens,
    };
    const threshold = this.opts.threshold ?? 0.8;
    const verdict = gateByConfidence(a.confidence, threshold);
    if (verdict !== 'pass') {
      if (this.opts.fallback) {
        const f = await this.opts.fallback.decide(req);
        return { ...f, cost: addCost(cost, f.cost) };
      }
      throw new Error(
        `jev decision below confidence threshold (${a.confidence} < ${threshold}) and no fallback decider configured`,
      );
    }
    return { choice: a.choice, confidence: a.confidence, cost, by: 'jev' };
  }
}
