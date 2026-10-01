import type { Decider, Decision, DecisionRequest } from '@wizardingcode/shibaox-core';
import { z } from 'zod';
import { describeError } from './errors.js';
import type { GenerateResult, LlmClient } from './llm-client.js';

export class LeadDecider implements Decider {
  constructor(
    private readonly client: LlmClient,
    private readonly ref: string,
  ) {}
  async decide(req: DecisionRequest): Promise<Decision> {
    const [first, ...rest] = req.options;
    if (!first) throw new Error('LeadDecider requires at least one option to decide between');
    const schema = z.object({ choice: z.enum([first, ...rest]), reasoning: z.string() });
    let r: GenerateResult<z.infer<typeof schema>> & { cost?: number };
    try {
      r = await this.client.generateObject(
        this.ref,
        {
          system:
            'You are the team lead. Decide the next step for this run. Answer with the JSON object requested.',
          messages: [
            {
              role: 'user',
              content: `Question: ${req.question}\nOptions: ${req.options.join(', ')}\n\nContext:\n${JSON.stringify(req.context).slice(0, 60_000)}`,
            },
          ],
          signal: req.signal,
        },
        schema,
      );
    } catch (e) {
      throw new Error(`lead decider ${this.ref} failed: ${describeError(e)}`);
    }
    if (!r.output) throw new Error('lead decider returned no structured decision');
    return {
      choice: r.output.choice,
      confidence: 1,
      by: `model:${this.ref}`,
      cost: {
        usd: r.cost ?? 0,
        inputTokens: r.usage.inputTokens,
        outputTokens: r.usage.outputTokens,
      },
    };
  }
}
