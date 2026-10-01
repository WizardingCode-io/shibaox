import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { homePaths } from '../src/home.js';
import { KNOWN_KEYS, maskSecret, SecretsStore } from '../src/secrets.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const store = () => {
  const dir = mkdtempSync(join(tmpdir(), 'secrets-'));
  dirs.push(dir);
  const paths = homePaths({ SHIBAOX_HOME: join(dir, '.shibaox') });
  return { paths, s: new SecretsStore(paths.secrets) };
};

describe('SecretsStore', () => {
  it('keeps keys in a 0600 file under the shibaox home and merges them over the environment', () => {
    const { paths, s } = store();
    expect(paths.secrets).toBe(join(paths.root, 'secrets.json'));
    expect(s.env({ OPENAI_API_KEY: 'from-env', PATH: '/bin' })).toEqual({
      OPENAI_API_KEY: 'from-env',
      PATH: '/bin',
    });
    s.set('OPENROUTER_API_KEY', 'sk-or-1234567890');
    s.set('OPENAI_API_KEY', 'vault-wins');
    expect(statSync(paths.secrets).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(paths.secrets, 'utf8'))).toEqual({
      version: 1,
      keys: { OPENROUTER_API_KEY: 'sk-or-1234567890', OPENAI_API_KEY: 'vault-wins' },
    });
    // the vault is shibaox's own: it wins over what the shell happened to export
    expect(s.env({ OPENAI_API_KEY: 'from-env', PATH: '/bin' })).toEqual({
      OPENAI_API_KEY: 'vault-wins',
      OPENROUTER_API_KEY: 'sk-or-1234567890',
      PATH: '/bin',
    });
    s.unset('OPENAI_API_KEY');
    expect(s.env({})).toEqual({ OPENROUTER_API_KEY: 'sk-or-1234567890' });
    // another store on the same file sees the change (the CLI and the daemon share it)
    expect(new SecretsStore(paths.secrets).get('OPENROUTER_API_KEY')).toBe('sk-or-1234567890');
  });
  it('lists the known keys with where each comes from, never the value', () => {
    const { s } = store();
    s.set('OPENROUTER_API_KEY', 'sk-or-1234567890');
    const rows = s.list({ ANTHROPIC_API_KEY: 'sk-ant-abcdefgh' });
    expect(rows.find((r) => r.name === 'OPENROUTER_API_KEY')).toEqual({
      name: 'OPENROUTER_API_KEY',
      description: expect.stringContaining('OpenRouter'),
      set: true,
      source: 'vault',
      masked: 'sk-o…7890',
    });
    expect(rows.find((r) => r.name === 'ANTHROPIC_API_KEY')).toMatchObject({
      set: true,
      source: 'env',
    });
    expect(rows.find((r) => r.name === 'TYPESAFE_API_KEY')).toMatchObject({
      set: false,
      description: expect.stringContaining('Jev'),
    });
    expect(rows.find((r) => r.name === 'SHIBAOX_TELEGRAM_TOKEN')).toMatchObject({ set: false });
    expect(JSON.stringify(rows)).not.toContain('1234567890');
    expect(KNOWN_KEYS.map((k) => k.name)).toContain('OPENAI_API_KEY');
    // gh in git nodes and gates reads these: the vault must know them
    expect(KNOWN_KEYS.map((k) => k.name)).toEqual(
      expect.arrayContaining(['GH_TOKEN', 'GITHUB_TOKEN']),
    );
  });
  it('rejects names that are not environment variable names and empty values', () => {
    const { s } = store();
    expect(() => s.set('bad name', 'x')).toThrow(/name/);
    expect(() => s.set('OPENAI_API_KEY', '   ')).toThrow(/value/);
    expect(maskSecret('short')).toBe('•••••');
    expect(maskSecret('sk-or-1234567890')).toBe('sk-o…7890');
    expect(existsSync(s.path)).toBe(false); // nothing written for refused sets
  });
  it('HIGGSFIELD_API_KEY is known and must be the whole id:secret pair, trimmed', () => {
    const { s } = store();
    expect(KNOWN_KEYS.find((k) => k.name === 'HIGGSFIELD_API_KEY')?.description).toMatch(
      /open\.higgsfield\.ai/,
    );
    for (const bad of ['abc', ':def', 'abc:', 'a b:c']) {
      expect(() => s.set('HIGGSFIELD_API_KEY', bad)).toThrow(/whole key as copied/);
      try {
        s.set('HIGGSFIELD_API_KEY', bad);
      } catch (e) {
        expect(String(e)).toMatch(/id:secret, with its colon\): paste it as-is/);
        if (bad.length > 3) expect(String(e)).not.toContain(bad);
      }
    }
    expect(existsSync(s.path)).toBe(false);
    s.set('HIGGSFIELD_API_KEY', '  id-1234:secret-abcdef \n');
    expect(s.get('HIGGSFIELD_API_KEY')).toBe('id-1234:secret-abcdef');
    const row = s.list({}).find((r) => r.name === 'HIGGSFIELD_API_KEY');
    expect(row).toMatchObject({ set: true, source: 'vault', masked: 'id-1…cdef' });
    expect(JSON.stringify(s.list({}))).not.toContain('secret-abcdef');
  });
});
