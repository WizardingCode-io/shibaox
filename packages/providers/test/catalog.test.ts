import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCatalog } from '../src/index.js';

describe('catalog.yaml', () => {
  const entries = loadCatalog();
  it('has every provider from the product list, with unique ids', () => {
    const ids = entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of [
      'anthropic',
      'anthropic-subscription',
      'openai',
      'openai-codex-subscription',
      'google',
      'gemini-cli-subscription',
      'xai',
      'azure',
      'bedrock',
      'bedrock-mantle',
      'vertex',
      'vertex-anthropic',
      'groq',
      'mistral',
      'cohere',
      'deepseek',
      'cerebras',
      'deepinfra',
      'fireworks',
      'togetherai',
      'moonshotai',
      'kimi-coding',
      'alibaba',
      'qwen-dashscope',
      'qwen-portal-subscription',
      'minimax',
      'huggingface',
      'perplexity',
      'zai',
      'zai-coding',
      'openrouter',
      'ollama',
      'ollama-cloud',
      'lmstudio',
      'nvidia',
      'chutes',
      'novita',
      'kilocode',
      'litellm',
      'vercel-gateway',
      'cloudflare-gateway',
      'clawrouter',
      'microsoft-foundry',
      'stepfun',
      'xiaomi',
      'volcengine',
      'tencent-cloud',
      'qianfan',
      'byteplus',
      'venice',
      'arcee',
      'synthetic',
      'vydra',
      'gmi-cloud',
      'opencode',
      'opencode-go',
      'github-copilot-subscription',
      'claude-max-proxy',
    ]) {
      expect(ids, `missing ${id}`).toContain(id);
    }
  });
  it('every direct entry has a kind and auth; every subscription entry has via_runtime', () => {
    for (const e of entries) {
      if (e.via_runtime) expect(e.kind).toBeUndefined();
      else {
        expect(e.kind, e.id).toBeDefined();
        expect(e.auth, e.id).toBeDefined();
      }
    }
  });
  it('openai-compatible entries have a base_url or base_url_env', () => {
    for (const e of entries.filter((e) => e.kind === 'openai-compatible'))
      expect(e.base_url ?? e.base_url_env, e.id).toBeTruthy();
  });
  it('rejects an invalid entry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cat-'));
    writeFileSync(join(dir, 'c.yaml'), '- id: x\n  name: X\n  kind: nope\n');
    expect(() => loadCatalog(join(dir, 'c.yaml'))).toThrow(/nope|kind/);
  });
});
