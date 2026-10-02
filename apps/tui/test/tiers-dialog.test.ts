import { expect, test } from 'bun:test';
import { routingPatch, tierChoices, tierRows } from '../src/component/dialogs/tiers.js';

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

test('routing is a row: on, off or default, patched as routing.jev', () => {
  expect(tierChoices('routing', models)).toEqual(['on', 'off', 'default']);
  const row = (c: Parameters<typeof tierRows>[0]) => tierRows(c).find((r) => r.name === 'routing');
  expect(row(undefined)?.value).toBe('default');
  expect(row({ root: '/o', organization: 'o', tiers: {}, routing: { jev: false } })?.value).toBe(
    'off',
  );
  expect(routingPatch('on')).toEqual({ routing: { jev: true } });
  expect(routingPatch('off')).toEqual({ routing: { jev: false } });
  expect(routingPatch('default')).toEqual({ routing: { jev: null } });
});
