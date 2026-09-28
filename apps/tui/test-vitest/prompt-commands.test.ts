import { homedir, tmpdir } from 'node:os';
import type { ModelChoice } from '@wizardingcode/shibaox-daemon';
import { describe, expect, it } from 'vitest';
import {
  applyPromptCommand,
  completeCommand,
  homeCommands,
  type PromptContext,
  parsePromptCommand,
  toSubmitRequest,
} from '../src/model/prompt-commands.js';

const ctx: PromptContext = { org: '/demo/org', project: '/demo/project', adapter: 'mock' };
const home = (workflows: string[] = []) => homeCommands(workflows);

describe('prompt commands', () => {
  it('parses a slash command with its argument', () => {
    expect(parsePromptCommand('/workflow hello', home())).toEqual({
      command: 'workflow',
      arg: 'hello',
    });
    expect(parsePromptCommand('/runs', home())).toEqual({ command: 'runs', arg: '' });
    expect(parsePromptCommand('add /health', home())).toBeUndefined();
    expect(parsePromptCommand('/nope x', home())).toBeUndefined();
  });
  it('completes command names and workflow names', () => {
    const c = (text: string, workflows: string[] = []) =>
      completeCommand(text, { commands: home(workflows) });
    expect(c('/wor', ['hello-feature'])[0]).toEqual({
      label: '/workflow',
      insert: '/workflow ',
      hint: 'pick a workflow of the org',
    });
    expect(c('/workflow hel', ['hello-feature', 'other'])[0]?.insert).toBe(
      '/workflow hello-feature',
    );
    expect(c('/adapter c')[0]?.insert).toBe('/adapter claude-code');
    expect(c('hello')).toEqual([]);
    // a prompt with its own commands (the session): actions with the label as hint
    const session = [{ name: 'diff', kind: 'action' as const, hint: 'Diff of the run' }];
    expect(completeCommand('/d', { commands: session })).toEqual([
      { label: '/diff', insert: '/diff ', hint: 'Diff of the run' },
    ]);
  });
  it('applies commands with validation', () => {
    expect(applyPromptCommand(ctx, { command: 'project', arg: '~' }, { cwd: '/x' })).toMatchObject({
      project: homedir(),
    });
    expect(
      applyPromptCommand(ctx, { command: 'project', arg: '.' }, { cwd: tmpdir() }),
    ).toMatchObject({ project: tmpdir() });
    expect(
      applyPromptCommand(ctx, { command: 'project', arg: '/nope/nothing' }, { cwd: '/x' }),
    ).toEqual({ error: 'Project not found: /nope/nothing' });
    expect(applyPromptCommand(ctx, { command: 'budget', arg: 'abc' }, { cwd: '/x' })).toEqual({
      error: 'Budget must be a number',
    });
    expect(applyPromptCommand(ctx, { command: 'budget', arg: '5' }, { cwd: '/x' })).toMatchObject({
      budgetUsd: 5,
    });
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

describe('/model values', () => {
  const choice = (ref: string, configured: boolean): ModelChoice => {
    const [provider, ...rest] = ref.split('/');
    return { ref, provider: provider ?? '', model: rest.join('/'), configured };
  };
  it('offers "default" (org routing) first and keeps usable models ahead of the top-10 cut', () => {
    const many = Array.from({ length: 20 }, (_, i) => choice(`dead-${i}/deep-${i}`, false));
    const models = [...many, choice('anthropic-subscription/deep-thinker', true)];
    const cmds = homeCommands([], models);
    const list = completeCommand('/model ', { commands: cmds });
    expect(list[0]).toMatchObject({ label: 'default', hint: 'org routing' });
    const d = completeCommand('/model d', { commands: cmds }).map((s) => s.label);
    expect(d.length).toBeLessThanOrEqual(10);
    const usable = d.indexOf('anthropic-subscription/deep-thinker');
    expect(usable).toBeGreaterThanOrEqual(0);
    for (const dead of d.filter((l) => l.startsWith('dead-')))
      expect(d.indexOf(dead)).toBeGreaterThan(usable);
  });
  it('"default" clears the model; a ref must look like provider/model', () => {
    const withModel = { ...ctx, model: 'a/b' };
    expect(
      applyPromptCommand(withModel, { command: 'model', arg: 'default' }, { cwd: '/x' }),
    ).toEqual({ ...ctx, model: undefined });
    expect(applyPromptCommand(ctx, { command: 'model', arg: 'nope' }, { cwd: '/x' })).toMatchObject(
      {
        error: expect.stringContaining('provider/model'),
      },
    );
    // picking an adapter by hand drops the model (the model decides the adapter otherwise)
    expect(
      applyPromptCommand(withModel, { command: 'adapter', arg: 'mock' }, { cwd: '/x' }),
    ).toEqual({ ...ctx, adapter: 'mock', model: undefined });
  });
});
