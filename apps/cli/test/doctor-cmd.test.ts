import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scaffoldOrg } from '@wizardingcode/shibaox-daemon';
import { afterEach, describe, expect, it } from 'vitest';

const bin = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});
const cli = (env: Record<string, string>, ...args: string[]) =>
  new Promise<{ code: number; stdout: string }>((resolve) => {
    execFile(
      process.execPath,
      [bin, ...args],
      { env: { PATH: process.env.PATH ?? '', SHIBAOX_NO_AUTOSTART: '1', ...env } },
      (err, stdout) =>
        resolve({ code: (err as { code?: number } | null)?.code ?? 0, stdout: String(stdout) }),
    );
  });

describe('shibaox doctor: decisions', () => {
  it('names the decision tier of the home org and whether it is usable', async () => {
    const home = mkdtempSync(join(tmpdir(), 'doctor-'));
    tmp.push(home);
    scaffoldOrg(home);
    const r = await cli({ SHIBAOX_HOME: home }, 'doctor');
    const line = r.stdout.split('\n').find((l) => /\bdecisions\b/.test(l)) ?? '';
    expect(line).toContain('jev-latest');
    expect(line).toMatch(/TYPESAFE_API_KEY/);
  });
  it('with the TypeSafe key and Jev as an OpenRouter model, says to switch to jev-latest', async () => {
    const home = mkdtempSync(join(tmpdir(), 'doctor-'));
    tmp.push(home);
    scaffoldOrg(home);
    writeFileSync(
      join(home, 'org', 'models.yaml'),
      'providers: {}\ntiers: { strong: anthropic/claude-sonnet-5, decision: openrouter/typesafe/jev-1.13 }\nroles: {}\ngates: {}\n',
    );
    const r = await cli(
      { SHIBAOX_HOME: home, OPENROUTER_API_KEY: 'k', TYPESAFE_API_KEY: 't' },
      'doctor',
    );
    const line = r.stdout.split('\n').find((l) => /\bdecisions\b/.test(l)) ?? '';
    expect(line).toContain('openrouter/typesafe/jev-1.13');
    expect(line).toContain('switch the decision tier to jev-latest for typed decisions');
  });
});
