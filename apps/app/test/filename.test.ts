import { describe, expect, it } from 'vitest';
import { suggestName } from '../src/markdown/filename.js';

describe('suggestName: a file name for a code block', () => {
  it('takes a file name from the fence info', () => {
    expect(suggestName('x', 'js', 'js fibonacci.js')).toBe('fibonacci.js');
    expect(suggestName('x', 'ts', 'ts title="src/app.ts"')).toBe('app.ts');
  });
  it('takes a "file:" comment on the first line', () => {
    expect(suggestName('// file: utils/sum.js\nexport const a = 1;', 'js')).toBe('sum.js');
    expect(suggestName('# File: report.py\nprint(1)', 'python')).toBe('report.py');
  });
  it('names code after its first function or class', () => {
    expect(suggestName('function fibonacci(n) {\n  return n;\n}', 'javascript')).toBe(
      'fibonacci.js',
    );
    expect(suggestName('export class OrderBook {}', 'typescript')).toBe('OrderBook.ts');
    expect(suggestName('def parse_rows(rows):\n    pass', 'python')).toBe('parse_rows.py');
    expect(suggestName('const fibonacci = (n) => n;', 'js')).toBe('fibonacci.js');
  });
  it('falls back to a name per language', () => {
    expect(suggestName('a,b\n1,2', 'csv')).toBe('table.csv');
    expect(suggestName('# Notes', 'md')).toBe('notes.md');
    expect(suggestName('{"a":1}', 'json')).toBe('data.json');
    expect(suggestName('echo hi', 'bash')).toBe('script.sh');
    expect(suggestName('SELECT 1', 'sql')).toBe('query.sql');
    expect(suggestName('hello', undefined)).toBe('snippet.txt');
    expect(suggestName('x', 'whatever')).toBe('snippet.whatever');
  });
});
