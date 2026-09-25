import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrg } from '@shibaox/schemas';
import { describe, expect, it } from 'vitest';
import { scaffoldOrg } from '../src/commands/init.js';

describe('scaffoldOrg', () => {
  it('creates a loadable org and the vault skeleton', () => {
    const dir = mkdtempSync(join(tmpdir(), 'init-'));
    const files = scaffoldOrg(dir);
    expect(files.length).toBeGreaterThan(5);
    const org = loadOrg(join(dir, 'org'));
    expect(org.workflows['hello-feature']).toBeDefined();
    expect(org.teams.engineering?.gates).toEqual(['tests']);
    for (const d of ['00-org', '10-projects', '20-clients', '30-knowledge', '90-system'])
      expect(existsSync(join(dir, 'vault', d))).toBe(true);
    expect(readFileSync(join(dir, 'org', '.gitignore'), 'utf8')).toContain('.shibaox/');
  });
  it('does not overwrite existing files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'init-'));
    scaffoldOrg(dir);
    expect(scaffoldOrg(dir)).toEqual([]);
  });
});
