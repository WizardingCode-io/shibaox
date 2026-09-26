import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AutoApproveHuman } from '@shibaox/core';
import { startFakeJev } from '@shibaox/jev/testing';
import { startFakeOpenAI } from '@shibaox/providers/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { scaffoldOrg } from '../src/commands/init.js';
import { runWorkflow } from '../src/commands/run.js';

const sample = fileURLToPath(new URL('../../../examples/sample-repo', import.meta.url));
let fakes: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const f of fakes) await f.close();
  fakes = [];
});

describe('shibaox run --adapter direct (fake providers)', () => {
  it('completes hello-feature with a direct model, jev checks and a judge fallback', async () => {
    const llm = await startFakeOpenAI((req, turn) => {
      const text = JSON.stringify(req.messages);
      if (text.includes('Rubric:')) return { content: '{"passed": true, "evidence": "fine"}' };
      if (text.includes('Options: ship, rework'))
        return { content: '{"choice": "ship", "reasoning": "ok"}' };
      return turn % 2 === 0
        ? { toolCalls: [{ name: 'finish', args: { output: { note: 'done' }, summary: 'done' } }] }
        : { content: 'done' };
    });
    const jev = await startFakeJev((req) =>
      Object.fromEntries(
        Object.keys(req.questions).map((k) => [
          k,
          req.questions[k]?.type === 'choice'
            ? {
                type: 'choice',
                choice: 'ship',
                confidence: 0.95,
                probabilities: { ship: 0.95, rework: 0.05 },
              }
            : { type: 'noul', noul: 0.9 },
        ]),
      ),
    );
    fakes.push(llm, jev);
    const dir = mkdtempSync(join(tmpdir(), 'e2e-'));
    scaffoldOrg(dir);
    writeFileSync(
      join(dir, 'org/models.yaml'),
      `providers: {}\ntiers: { strong: fake/m, cheap: fake/m, decision: jev-latest }\nroles: {}\ngates: {}\n`,
    );
    writeFileSync(
      join(dir, 'org/gates/tests.yaml'),
      'gate: tests\nchecks:\n  - { name: unit-tests, type: code, command: "npm test", timeout_ms: 120000 }\n  - { name: spec, type: jev, question: "The outputs implement the request", threshold: 0.8 }\n',
    );
    const project = join(dir, 'project');
    cpSync(sample, project, { recursive: true });
    const state = await runWorkflow('hello-feature', {
      org: join(dir, 'org'),
      project,
      db: join(dir, 'events.db'),
      input: 'add /health',
      adapter: 'direct',
      human: new AutoApproveHuman(),
      log: () => {},
      env: { TYPESAFE_API_KEY: 'k', SHIBAOX_JEV_BASE_URL: jev.baseURL },
      extraProviders: [
        {
          id: 'fake',
          name: 'Fake',
          kind: 'openai-compatible',
          base_url: llm.baseURL,
          auth: { type: 'none' },
          models: ['m'],
          pricing: { m: { input_per_m: 1, output_per_m: 1 } },
          verify: false,
          capabilities: { tools: true },
        },
      ],
    });
    expect(state.status).toBe('completed');
    expect(state.nodes.qa?.status).toBe('passed');
    expect(state.lastGateReport?.checks.map((c) => c.type)).toEqual(['code', 'jev']);
    expect(state.spentUsd).toBeGreaterThan(0);
  });
});
