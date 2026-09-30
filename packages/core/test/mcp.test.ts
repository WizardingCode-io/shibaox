import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogEntrySchema } from '@wizardingcode/shibaox-schemas';
import { describe, expect, it } from 'vitest';
import { expandHeaders, mcpServerSpec, modelToolName, skillsPrompt } from '../src/index.js';

describe('mcpServerSpec', () => {
  const entry = CatalogEntrySchema.parse({
    id: 'docs',
    type: 'mcp',
    description: 'docs',
    server: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'docs-mcp'],
      env: { DOCS_MODE: 'fast' },
      env_keys: ['DOCS_TOKEN'],
      tools: ['search'],
    },
  });
  it('picks the env keys from the environment on top of the fixed env', () => {
    const spec = mcpServerSpec(entry, { DOCS_TOKEN: 't0k', OTHER: 'x' });
    expect(spec).toEqual({
      id: 'docs',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'docs-mcp'],
      env: { DOCS_MODE: 'fast' },
      secrets: { DOCS_TOKEN: 't0k' },
      tools: ['search'],
      timeoutMs: 30_000,
    });
  });
  it('a missing key is a clear error naming the entry, the key and the vault command', () => {
    expect(() => mcpServerSpec(entry, {})).toThrow(
      'catalog entry "docs" needs DOCS_TOKEN in the vault (shibaox keys set DOCS_TOKEN)',
    );
  });
  it('an http server carries its url and headers, with env keys expanded in header values', () => {
    const http = CatalogEntrySchema.parse({
      id: 'web',
      type: 'mcp',
      description: 'web',
      server: {
        transport: 'http',
        url: 'https://mcp.example.com/mcp',
        headers: { Authorization: `Bearer $${'{WEB_TOKEN}'}` },
        env_keys: ['WEB_TOKEN'],
      },
    });
    const spec = mcpServerSpec(http, { WEB_TOKEN: 'abc' });
    expect(spec.transport).toBe('http');
    expect(spec.url).toBe('https://mcp.example.com/mcp');
    // the spec keeps the template (Claude Code expands it from its own env); the direct adapter expands it
    expect(spec.headers).toEqual({ Authorization: `Bearer $${'{WEB_TOKEN}'}` });
    expect(spec.secrets).toEqual({ WEB_TOKEN: 'abc' });
    expect(expandHeaders(spec)).toEqual({ Authorization: 'Bearer abc' });
  });
  it('an entry that is not an mcp server is refused', () => {
    const tool = CatalogEntrySchema.parse({ id: 'x', type: 'tool', description: 'd' });
    expect(() => mcpServerSpec(tool, {})).toThrow(/not an mcp entry/);
  });
});

describe('skillsPrompt', () => {
  it('joins each SKILL.md without its frontmatter under a heading with the skill id', () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-'));
    mkdirSync(join(root, 'skills', 'e2e'), { recursive: true });
    writeFileSync(
      join(root, 'skills', 'e2e', 'SKILL.md'),
      '---\nname: e2e\ndescription: end to end\n---\n# E2E\n\nOpen the page, then assert.\n',
    );
    mkdirSync(join(root, 'skills', 'style'), { recursive: true });
    writeFileSync(join(root, 'skills', 'style', 'SKILL.md'), 'Two-space indent.\n');
    const text = skillsPrompt(root, ['e2e', 'style']);
    expect(text).toContain('## Skill: e2e\n# E2E\n\nOpen the page, then assert.');
    expect(text).toContain('## Skill: style\nTwo-space indent.');
    expect(text).not.toContain('description: end to end');
    expect(skillsPrompt(root, [])).toBeUndefined();
  });
  it('a missing skill is an error naming the file', () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-'));
    expect(() => skillsPrompt(root, ['nope'])).toThrow(/skills\/nope\/SKILL\.md/);
  });
});

describe('modelToolName', () => {
  it('is mcp__<server>__<tool> with only [A-Za-z0-9_-], at most 64 characters, stable', () => {
    expect(modelToolName('echo', 'echo')).toBe('mcp__echo__echo');
    expect(modelToolName('docs', 'search.pages')).toBe('mcp__docs__search_pages');
    expect(modelToolName('docs', 'a/b:c d')).toBe('mcp__docs__a_b_c_d');
    const long = modelToolName('playwright', 'x'.repeat(80));
    expect(long).toHaveLength(64);
    expect(long).toMatch(/^mcp__playwright__x+_[a-z0-9]{6}$/);
    expect(modelToolName('playwright', 'x'.repeat(80))).toBe(long);
    expect(modelToolName('playwright', 'x'.repeat(81))).not.toBe(long);
  });
});
