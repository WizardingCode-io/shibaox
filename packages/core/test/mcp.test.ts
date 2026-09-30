import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogEntrySchema } from '@wizardingcode/shibaox-schemas';
import { describe, expect, it } from 'vitest';
import { mcpServerSpec, skillsPrompt } from '../src/index.js';

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
      env: { DOCS_MODE: 'fast', DOCS_TOKEN: 't0k' },
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
    expect(spec.headers).toEqual({ Authorization: 'Bearer abc' });
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
