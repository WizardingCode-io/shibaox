import { describe, expect, it } from 'vitest';
import { parseTextToolCalls } from '../src/text-tools.js';

describe('parseTextToolCalls', () => {
  it('finds tool calls written as text in the shapes models use, and returns the text without them', () => {
    const text = [
      'Vou lançar a equipa.',
      '<tools>',
      '{"name": "start_workflow", "arguments": {"workflow": "hello-feature", "request": "Set up Phaser"}}',
      '</tools>',
      'A seguir vejo os ficheiros.',
      '<tool_call>{"name":"list_files","arguments":{}}</tool_call>',
      '```json',
      '{"name": "read_file", "input": {"path": "a.ts"}}',
      '```',
      'finish',
      '{"output": {"text": "olá"}, "summary": "said hi"}',
    ].join('\n');
    const r = parseTextToolCalls(text);
    expect(r.calls).toEqual([
      { name: 'start_workflow', args: { workflow: 'hello-feature', request: 'Set up Phaser' } },
      { name: 'list_files', args: {} },
      { name: 'read_file', args: { path: 'a.ts' } },
      { name: 'finish', args: { output: { text: 'olá' }, summary: 'said hi' } },
    ]);
    expect(r.text).toBe('Vou lançar a equipa.\n\nA seguir vejo os ficheiros.');
  });
  it('leaves ordinary text and JSON that is not a tool call alone', () => {
    expect(parseTextToolCalls('Here is a config: {"name": "app", "version": 2}')).toEqual({
      calls: [],
      text: 'Here is a config: {"name": "app", "version": 2}',
    });
    expect(parseTextToolCalls('<tools>not json</tools> fine')).toEqual({
      calls: [],
      text: '<tools>not json</tools> fine',
    });
  });
});
