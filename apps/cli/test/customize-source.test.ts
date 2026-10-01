import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DaemonHttpError } from '@wizardingcode/shibaox-daemon';
import { describe, expect, it } from 'vitest';
import { mcpAddRequest, mcpConflictLine, skillSource } from '../src/commands/customize.js';

describe('skills add <source>', () => {
  it('owner/repo[/path] is a repository, with or without github.com in front', () => {
    expect(skillSource('anthropics/skills', {})).toEqual({
      source: 'repo',
      repo: 'anthropics/skills',
    });
    for (const s of [
      'anthropics/skills/skills',
      'github.com/anthropics/skills/skills',
      'https://github.com/anthropics/skills/skills',
    ])
      expect(skillSource(s, {}), s).toEqual({
        source: 'repo',
        repo: 'anthropics/skills',
        path: 'skills',
      });
    expect(skillSource('https://github.com/a/b', { id: ['x'] })).toEqual({
      source: 'repo',
      repo: 'a/b',
      ids: ['x'],
    });
    expect(skillSource('https://gitlab.com/a/b.git', {})).toEqual({
      source: 'repo',
      repo: 'https://gitlab.com/a/b.git',
    });
  });

  it('a folder only when it starts with . / ~ or --folder is given (an existing a/b dir is still a repo)', () => {
    expect(skillSource('./mine', {})).toEqual({ source: 'folder', path: resolve('mine') });
    expect(skillSource('/abs/skills', {})).toEqual({ source: 'folder', path: '/abs/skills' });
    expect(skillSource('~/skills', {})).toEqual({
      source: 'folder',
      path: join(homedir(), 'skills'),
    });
    expect(skillSource('apps/cli', {})).toMatchObject({ source: 'repo', repo: 'apps/cli' });
    expect(skillSource('apps/cli', { folder: true })).toEqual({
      source: 'folder',
      path: resolve('apps/cli'),
    });
  });
});

describe('mcp add', () => {
  it('--bearer-command is one argument per flag, never split on spaces', () => {
    const r = mcpAddRequest('hf', {
      url: 'https://x.example/mcp',
      bearerCommand: ['higgsfield', 'auth', 'token', 'a b'],
    });
    expect(r.server).toMatchObject({ bearer_command: ['higgsfield', 'auth', 'token', 'a b'] });
  });

  it('a 409 says whether to use --replace or to pick another id', () => {
    expect(
      mcpConflictLine(new DaemonHttpError(409, 'exists', 'catalog entry x already exists'), 'x'),
    ).toBe('x exists (use --replace)');
    expect(mcpConflictLine(new DaemonHttpError(409, 'not_mcp', 'no'), 'x')).toBe(
      'x is not an mcp entry (pick another id)',
    );
    expect(mcpConflictLine(new DaemonHttpError(409, 'catalog_file_collision', 'no'), 'x')).toBe(
      'catalog/x.yaml holds another entry (pick another id)',
    );
  });
});
