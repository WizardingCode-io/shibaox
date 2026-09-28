import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCatalog, ProviderRegistry } from '@wizardingcode/shibaox-providers';
import { loadOrg } from '@wizardingcode/shibaox-schemas';
import { describe, expect, it } from 'vitest';
import { scaffoldOrg } from '../src/commands/init.js';
import { formatModels } from '../src/commands/models.js';

function org(models: string) {
  const dir = mkdtempSync(join(tmpdir(), 'models-'));
  scaffoldOrg(dir);
  writeFileSync(join(dir, 'org/models.yaml'), models);
  return loadOrg(join(dir, 'org'));
}

describe('models command', () => {
  it('resolves each role to a direct ref', () => {
    const lines = formatModels(
      org('tiers: { strong: ollama/qwen2.5-coder:7b, cheap: ollama/llama3.2 }\n'),
      new ProviderRegistry(loadCatalog(), {}),
    );
    expect(lines.find((l) => l.startsWith('analyst'))).toMatch(/cheap\s+→ direct ollama\/llama3.2/);
    expect(lines.find((l) => l.startsWith('backend'))).toMatch(
      /strong\s+→ direct ollama\/qwen2.5-coder:7b/,
    );
    expect(lines.find((l) => l.startsWith('team-leader'))).toMatch(/strong/);
  });
  it('prints per-role errors without aborting', () => {
    const lines = formatModels(
      org('tiers: { strong: anthropic/claude-sonnet-5, cheap: ollama/llama3.2 }\n'),
      new ProviderRegistry(loadCatalog(), {}),
    );
    expect(lines.find((l) => l.startsWith('analyst'))).toMatch(/direct ollama\/llama3.2/);
    expect(lines.find((l) => l.startsWith('backend'))).toMatch(
      /!! provider "anthropic" is not configured/,
    );
  });
  it('shows the runtime for via_runtime refs', () => {
    const lines = formatModels(
      org('tiers: { strong: anthropic-subscription/claude-sonnet-5, cheap: ollama/llama3.2 }\n'),
      new ProviderRegistry(loadCatalog(), {}),
    );
    expect(lines.find((l) => l.startsWith('backend'))).toMatch(
      /runtime claude-code \(claude-sonnet-5\)/,
    );
  });
});
