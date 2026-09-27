import { expect, test } from 'bun:test';
import { tierChoices } from '../src/component/dialogs/tiers.js';

const models = [
  { ref: 'lmstudio/qwen', provider: 'lmstudio', model: 'qwen', configured: false, local: true },
  { ref: 'openrouter/openai/gpt-5', provider: 'openrouter', model: 'gpt-5', configured: true },
];

test('jev-latest is offered for the decision tier only; usable models come first', () => {
  expect(tierChoices('decision', models)[0]).toBe('jev-latest');
  expect(tierChoices('judge', models)).not.toContain('jev-latest');
  expect(tierChoices('strong', models)).toEqual(['openrouter/openai/gpt-5', 'lmstudio/qwen']);
  expect(tierChoices('adapter', models)).toEqual(['direct', 'claude-code', 'mock']);
});
