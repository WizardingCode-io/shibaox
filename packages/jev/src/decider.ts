import type { Decider, Decision, DecisionRequest } from '@shibaox/core';
import { choice } from '@typesafe-ai/sdk';
import { gateByConfidence, type JevClient } from './client.js';

export class JevDecider implements Decider {
  constructor(
    private readonly client: JevClient,
    private readonly opts: { threshold?: number; fallback?: Decider } = {},
  ) {}
  async decide(req: DecisionRequest): Promise<Decision> {
    const criteria = Object.fromEntries(req.options.map((o) => [o, o]));
    const state = JSON.stringify({
      question: req.question,
      input: req.context.input,
      previousOutputs: req.context.previousOutputs,
      lastGateReport: req.context.lastGateReport,
    });
    const r = await this.client.fanOut(state, {
      decision: choice(req.question || 'Choose the next step', criteria),
    });
    const a = r.answers.decision;
    const cost = {
      usd: r.cost,
      inputTokens: r.usage.inputTokens,
      outputTokens: r.usage.outputTokens,
    };
    const verdict = gateByConfidence(a.confidence, this.opts.threshold ?? 0.8);
    if (verdict !== 'pass' && this.opts.fallback) {
      const f = await this.opts.fallback.decide(req);
      return { ...f, cost: f.cost ? { ...f.cost, usd: f.cost.usd + cost.usd } : cost };
    }
    return { choice: a.choice, confidence: a.confidence, cost };
  }
}
