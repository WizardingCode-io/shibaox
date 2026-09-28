import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { installLine } from '../src/commands/doctor.js';
import { resolveTuiRoot } from '../src/commands/ui.js';
import { upgradeCommand } from '../src/commands/upgrade.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const file = (p: string, content = '') => {
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
};

describe('where the dashboard lives', () => {
  it('a monorepo checkout: the sibling apps/tui package', () => {
    const root = mkdtempSync(join(tmpdir(), 'tui-root-'));
    dirs.push(root);
    const cli = join(root, 'apps/cli/dist/commands/ui.js');
    file(cli);
    file(join(root, 'apps/tui/src/main.tsx'));
    expect(resolveTuiRoot(pathToFileURL(cli).href)).toBe(join(root, 'apps/tui/'));
  });
  it('an npm install: the @wizardingcode/shibaox-tui package next to the CLI, even with an exports map', () => {
    const root = mkdtempSync(join(tmpdir(), 'tui-root-'));
    dirs.push(root);
    const cli = join(root, 'lib/node_modules/shibaox/dist/commands/ui.js');
    file(cli);
    const tui = join(root, 'lib/node_modules/@wizardingcode/shibaox-tui');
    file(
      join(tui, 'package.json'),
      JSON.stringify({ name: '@wizardingcode/shibaox-tui', exports: { '.': './src/app.tsx' } }),
    );
    file(join(tui, 'src/main.tsx'));
    file(join(tui, 'src/app.tsx'));
    expect(realpathSync(resolveTuiRoot(pathToFileURL(cli).href))).toBe(realpathSync(tui));
  });
});

describe('an npm install of shibaox', () => {
  it('doctor and upgrade say how it is updated', async () => {
    const root = mkdtempSync(join(tmpdir(), 'npm-inst-'));
    dirs.push(root);
    const cli = join(root, 'lib/node_modules/shibaox/dist/index.js');
    file(cli);
    // npm's bin is a symlink to the package: the real path decides
    const bin = join(root, 'bin/shibaox');
    mkdirSync(join(root, 'bin'), { recursive: true });
    symlinkSync(cli, bin);
    const line = installLine({ root: join(root, 'home'), env: { PATH: '/usr/bin' }, cli: bin });
    expect(line.ok).toBe(true);
    expect(line.detail).toMatch(/npm i -g shibaox/);
    const lines: string[] = [];
    const code = await upgradeCommand({
      app: join(root, 'home/app'),
      cli,
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
      restart: async () => '',
      out: { line: (l) => lines.push(l), obj: () => {}, json: false },
    });
    expect(code).toBe(1);
    expect(lines.join('\n')).toMatch(/npm i -g shibaox@latest/);
  });
});
