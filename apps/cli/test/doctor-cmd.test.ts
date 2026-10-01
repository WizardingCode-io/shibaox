import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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
});
