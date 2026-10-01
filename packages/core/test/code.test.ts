import { describe, expect, it } from 'vitest';
import { runArgv, runCommand } from '../src/index.js';

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

describe('runArgv', () => {
  it('runs without a shell: $HOME and operators stay literal', async () => {
    const r = await runArgv({
      argv: ['echo', '$HOME', ';', 'ls'],
      cwd: process.cwd(),
      timeoutMs: 5000,
    });
    expect(r.stdout.trim()).toBe('$HOME ; ls');
    expect(r.exitCode).toBe(0);
  });
  it('kills a hanging program on timeout and honours inheritEnv: false', async () => {
    const t = await runArgv({ argv: ['sleep', '5'], cwd: process.cwd(), timeoutMs: 200 });
    expect(t.timedOut).toBe(true);
    const e = await runArgv({
      argv: ['env'],
      cwd: process.cwd(),
      timeoutMs: 5000,
      inheritEnv: false,
      env: { ONLY: '1', PATH: process.env.PATH ?? '' },
    });
    expect(e.stdout).toContain('ONLY=1');
    expect(e.stdout).not.toContain('HOME=');
  });
  it('reports a missing program without rejecting', async () => {
    const r = await runArgv({
      argv: ['definitely-not-a-program-xyz'],
      cwd: process.cwd(),
      timeoutMs: 5000,
    });
    expect(r.exitCode).toBeNull();
    expect(r.stderr).toContain('ENOENT');
  });
});

describe('stdin of a command', () => {
  it('is closed: a program that waits for input ends at once instead of hanging', async () => {
    const r = await runCommand({ command: 'cat', cwd: process.cwd(), timeoutMs: 5000 });
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(0);
  });
  it('caps stderr, stops on too much stdout, and is killed by an abort signal', async () => {
    const big = await runArgv({
      argv: [
        'node',
        '-e',
        "process.stderr.write('e'.repeat(10000)); process.stdout.write('o'.repeat(10000))",
      ],
      cwd: process.cwd(),
      timeoutMs: 5000,
      maxStderrBytes: 4096,
    });
    expect(big.stderr.length).toBe(4096);
    expect(big.stdout.length).toBe(10000);
    const over = await runArgv({
      argv: ['node', '-e', "setInterval(() => process.stdout.write('o'.repeat(1000)), 1)"],
      cwd: process.cwd(),
      timeoutMs: 5000,
      maxStdoutBytes: 5000,
    });
    expect(over.overflow).toBe(true);
    expect(over.timedOut).toBe(false);
    const ac = new AbortController();
    const started = Date.now();
    const p = runArgv({
      argv: ['sleep', '5'],
      cwd: process.cwd(),
      timeoutMs: 5000,
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 100);
    const a = await p;
    expect(a.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(3000);
    const pre = await runArgv({
      argv: ['sleep', '5'],
      cwd: process.cwd(),
      timeoutMs: 5000,
      signal: AbortSignal.abort(),
    });
    expect(pre.aborted).toBe(true);
  });
});
