import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
      { env: { SHIBAOX_NO_AUTOSTART: '1', ...env } },
      (err, stdout) =>
        resolve({ code: (err as { code?: number } | null)?.code ?? 0, stdout: String(stdout) }),
    );
  });

describe('shibaox doctor: higgsfield', () => {
  it('reports the CLI, the account and the credits when the CLI answers', async () => {
    const home = mkdtempSync(join(tmpdir(), 'doctor-hf-'));
    tmp.push(home);
    scaffoldOrg(home);
    const fakeBin = join(home, 'fakebin');
    mkdirSync(fakeBin);
    writeFileSync(
      join(fakeBin, 'higgsfield'),
      '#!/bin/sh\ncase "$1" in version) echo "higgsfield 1.1.26 (abc) built x";; account) echo \'{"credits": 2, "email": "a@b.c", "subscription_plan_type": "plus"}\';; esac\n',
    );
    chmodSync(join(fakeBin, 'higgsfield'), 0o755);
    const r = await cli(
      { SHIBAOX_HOME: home, PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
      'doctor',
    );
    const line = r.stdout.split('\n').find((l) => /\bhiggsfield\b/.test(l)) ?? '';
    expect(line).toMatch(/1\.1\.26/);
    expect(line).toMatch(/a@b\.c/);
    expect(line).toMatch(/2 credits/);
  });
  it('says how to install it when it is missing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'doctor-hf2-'));
    tmp.push(home);
    scaffoldOrg(home);
    const r = await cli({ SHIBAOX_HOME: home, PATH: '/usr/bin:/bin' }, 'doctor');
    const line = r.stdout.split('\n').find((l) => /\bhiggsfield\b/.test(l)) ?? '';
    expect(line).toMatch(/not installed/);
  });
});
