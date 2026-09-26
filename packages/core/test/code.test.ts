import { describe, expect, it } from 'vitest';
import { runCommand } from '../src/index.js';

describe('runCommand', () => {
  it('captures stdout and exit code', async () => {
    const r = await runCommand({
      command: 'echo hi && exit 3',
      cwd: process.cwd(),
      timeoutMs: 5000,
    });
    expect(r.stdout.trim()).toBe('hi');
    expect(r.exitCode).toBe(3);
    expect(r.timedOut).toBe(false);
  });
  it('kills a hanging command on timeout', async () => {
    const r = await runCommand({ command: 'sleep 5', cwd: process.cwd(), timeoutMs: 200 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).not.toBe(0);
  });
  it('never rejects when the child exits right as a tiny timeout fires', async () => {
    for (let i = 0; i < 20; i++) {
      const r = await runCommand({ command: 'echo hi', cwd: process.cwd(), timeoutMs: 1 });
      expect(r).toBeDefined();
      expect(typeof r.timedOut).toBe('boolean');
    }
  });
  it('does not inherit process.env when inheritEnv is false', async () => {
    process.env.SHIBAOX_CODE_SECRET = 's3cret';
    try {
      const inherited = await runCommand({ command: 'env', cwd: process.cwd(), timeoutMs: 5000 });
      expect(inherited.stdout).toContain('SHIBAOX_CODE_SECRET');
      const scrubbed = await runCommand({
        command: 'env',
        cwd: process.cwd(),
        timeoutMs: 5000,
        inheritEnv: false,
        env: { PATH: process.env.PATH ?? '', ONLY_ME: '1' },
      });
      expect(scrubbed.stdout).not.toContain('SHIBAOX_CODE_SECRET');
      expect(scrubbed.stdout).toContain('ONLY_ME=1');
    } finally {
      delete process.env.SHIBAOX_CODE_SECRET;
    }
  });
});
