import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyPromptCommand,
  completeCommand,
  type PromptContext,
  parsePromptCommand,
  toSubmitRequest,
} from '../src/model/prompt-commands.js';

const ctx: PromptContext = { org: '/demo/org', project: '/demo/project', adapter: 'mock' };

describe('prompt commands', () => {
  it('parses a slash command with its argument', () => {
    expect(parsePromptCommand('/workflow hello')).toEqual({ command: 'workflow', arg: 'hello' });
    expect(parsePromptCommand('/runs')).toEqual({ command: 'runs', arg: '' });
    expect(parsePromptCommand('add /health')).toBeUndefined();
    expect(parsePromptCommand('/nope x')).toBeUndefined();
  });
  it('completes command names and workflow names', () => {
    expect(completeCommand('/wor', { workflows: ['hello-feature'] })[0]?.insert).toBe('/workflow ');
    expect(
      completeCommand('/workflow hel', { workflows: ['hello-feature', 'other'] })[0]?.insert,
    ).toBe('/workflow hello-feature');
    expect(completeCommand('/adapter c', { workflows: [] })[0]?.insert).toBe(
      '/adapter claude-code',
    );
    expect(completeCommand('hello', { workflows: [] })).toEqual([]);
  });
  it('applies commands with validation', () => {
    expect(applyPromptCommand(ctx, { command: 'budget', arg: 'abc' }, { cwd: '/x' })).toEqual({
      error: 'Budget must be a number',
    });
    expect(applyPromptCommand(ctx, { command: 'budget', arg: '5' }, { cwd: '/x' })).toMatchObject({
      budgetUsd: 5,
    });
    expect(
      applyPromptCommand(ctx, { command: 'project', arg: '~/x' }, { cwd: '/x' }),
    ).toMatchObject({ project: join(homedir(), 'x') });
    expect(
      applyPromptCommand(ctx, { command: 'project', arg: 'rel' }, { cwd: '/base' }),
    ).toMatchObject({ project: '/base/rel' });
    expect(applyPromptCommand(ctx, { command: 'adapter', arg: 'nope' }, { cwd: '/x' })).toEqual({
      error: 'Adapter must be one of mock, claude-code, direct',
    });
    expect(
      applyPromptCommand(ctx, { command: 'workspace', arg: 'worktree' }, { cwd: '/x' }),
    ).toMatchObject({ workspace: 'worktree' });
    expect(applyPromptCommand(ctx, { command: 'workflow', arg: '' }, { cwd: '/x' })).toEqual({
      error: 'Workflow name is required',
    });
  });
  it('builds the submit request', () => {
    expect(
      toSubmitRequest({ ...ctx, workflow: 'hello-feature', budgetUsd: 2 }, 'add /health'),
    ).toEqual({
      orgRoot: '/demo/org',
      project: '/demo/project',
      workflow: 'hello-feature',
      input: 'add /health',
      adapter: 'mock',
      workspace: undefined,
      budgetUsd: 2,
    });
  });
});
