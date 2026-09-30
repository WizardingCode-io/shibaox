import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { telegramText } from '../src/channels/telegram.js';
import { projectProtectedGlobs } from '../src/protected.js';

describe('the project protected list', () => {
  it('always includes shibaox.yaml itself; comes from the project checkout; a broken file refuses, never fails open', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pp-'));
    expect(projectProtectedGlobs(dir)).toEqual(['shibaox.yaml']);
    writeFileSync(join(dir, 'shibaox.yaml'), 'protected: [infra/**]\n');
    expect(projectProtectedGlobs(dir)).toEqual(['shibaox.yaml', 'infra/**']);
    writeFileSync(join(dir, 'shibaox.yaml'), 'protected: [\n');
    expect(() => projectProtectedGlobs(dir)).toThrow(/shibaox\.yaml/);
  });
});

describe('a file approval on Telegram', () => {
  it('says it is a write and names the category', () => {
    const text = telegramText({
      id: 'approval:1',
      kind: 'approval',
      runId: 'r1234567890',
      nodeId: 'n',
      at: 't',
      prompt: 'write infra/main.tf',
      detail: { role: 'backend', program: 'write', category: 'protected', tool: 'file' },
    });
    expect(text).toMatch(/protected/);
    expect(text).toMatch(/write infra\/main\.tf/);
    expect(text).toMatch(/file/i);
  });
});
