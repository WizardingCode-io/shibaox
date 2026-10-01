import { describe, expect, it } from 'vitest';
import { parseCsv } from '../src/markdown/csv.js';

describe('parseCsv loose', () => {
  const ragged = 'IMPOSTO,N PROCESSO,VALOR\nIVA,1503,38976,8 448,65\nIRS,1503\nCOIMAS,1503,1084901';
  it('strict parsing refuses ragged rows (the chat heuristic stays honest)', () => {
    expect(parseCsv(ragged)).toBeUndefined();
  });
  it('loose parsing keeps every row: short ones padded, long ones with their extra cells', () => {
    const t = parseCsv(ragged, undefined, { loose: true });
    expect(t?.header).toEqual(['IMPOSTO', 'N PROCESSO', 'VALOR', '', '']);
    expect(t?.rows).toEqual([
      ['IVA', '1503', '38976', '8 448', '65'],
      ['IRS', '1503', '', '', ''],
      ['COIMAS', '1503', '1084901', '', ''],
    ]);
    expect(t?.ragged).toBe(true);
  });
  it('a semicolon file (Portuguese Excel) is detected', () => {
    const t = parseCsv('a;b\n1;2\n3;4', undefined, { loose: true });
    expect(t?.delimiter).toBe(';');
    expect(t?.ragged).toBe(false);
  });
});
