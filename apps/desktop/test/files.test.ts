import { describe, expect, it } from 'vitest';
import { openable, tempName } from '../src/files.js';

describe('what the desktop opens for the app', () => {
  it('documents, data, code and images open; executable kinds never do', () => {
    for (const n of [
      'table.csv',
      'notes.md',
      'fib.js',
      'page.html',
      'photo.png',
      'data.json',
      'Dockerfile',
      'report.txt',
    ])
      expect(openable(n), n).toBe(true);
    for (const n of [
      'run.command',
      'x.sh',
      'Tool.app',
      'setup.pkg',
      'disk.dmg',
      'a.jar',
      'b.exe',
      'c.scpt',
      'd.bat',
      'e.ps1',
      'f.terminal',
      'g.webloc',
      'h.url',
    ])
      expect(openable(n), n).toBe(false);
  });
  it('a temp name keeps the extension and never a directory', () => {
    expect(tempName('../../etc/passwd.txt')).toBe('passwd.txt');
    expect(tempName('scripts/fib.js')).toBe('fib.js');
    expect(tempName('')).toBe('file.txt');
  });
});
