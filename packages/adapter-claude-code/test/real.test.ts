import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutoApproveHuman, collectRun, type TaskJob } from '@shibaox/core';
import { RoleSchema } from '@shibaox/schemas';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../src/index.js';

const hasClaude = (() => {
  try {
    execFileSync('claude', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
describe.skipIf(process.env.SHIBAOX_REAL_TESTS !== '1' || !hasClaude)('real claude-code', () => {
  it('creates a file in a temp workspace', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'cc-'));
    const job: TaskJob = {
      runId: 'r',
      nodeId: 'n',
      role: RoleSchema.parse({ role: 'backend', tools: ['read', 'write'] }),
      instruction: 'Create hello.txt containing exactly "hi". Then stop.',
      input: {},
      workspace: ws,
      context: { previousOutputs: {} },
      budgetRemainingUsd: 0.5,
    };
    const r = await collectRun(
      new ClaudeCodeAdapter({ human: new AutoApproveHuman(), maxTurns: 6 }),
      job,
      { signal: new AbortController().signal, log: console.log },
    );
    expect(r.cost?.usd).toBeGreaterThan(0);
  }, 180_000);
});
