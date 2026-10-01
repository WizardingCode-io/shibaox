/** A parsed delimiter-separated text: a header row and the data rows. */
export interface CsvTable {
  header: string[];
  rows: string[][];
  delimiter: string;
}

function split(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      cells.push(cell);
      cell = '';
    } else cell += ch;
  }
  cells.push(cell);
  return cells.map((c) => c.trim());
}

/**
 * CSV or TSV as a table, or undefined when the text is not one: at least two rows, at least two
 * columns, every row with the header's column count (quoted cells with commas and `""` handled).
 */
export function parseCsv(text: string, delimiter?: string): CsvTable | undefined {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((l) => l.trim() !== '');
  if (lines.length < 2) return undefined;
  const first = lines[0] as string;
  const d =
    delimiter ??
    (first.includes('\t') ? '\t' : first.includes(';') && !first.includes(',') ? ';' : ',');
  const header = split(first, d);
  if (header.length < 2) return undefined;
  const rows: string[][] = [];
  for (const line of lines.slice(1)) {
    const cells = split(line, d);
    if (cells.length !== header.length) return undefined;
    rows.push(cells);
  }
  return { header, rows, delimiter: d };
}

/** Columns whose cells are all numbers (right-aligned in the table). */
export function numericColumns(t: CsvTable): boolean[] {
  return t.header.map((_, i) =>
    t.rows.every((r) => /^-?\d+([.,]\d+)?%?$/.test((r[i] ?? '').replace(/\s/g, ''))),
  );
}

/**
 * An unlabelled block that is data, not code: comma- or tab-separated (never `;`), at least
 * three lines, a header of short plain names (no brackets, operators or colons), no empty
 * cell in the header, no row ending in the delimiter, and either a numeric column or three
 * or more columns. Two statements ending in `;` or two calls with arguments stay code.
 */
export function looksTabular(text: string): CsvTable | undefined {
  const first = text.split('\n').find((l) => l.trim() !== '') ?? '';
  const delimiter = first.includes('\t') ? '\t' : ',';
  const t = parseCsv(text, delimiter);
  if (!t || t.rows.length < 2) return undefined;
  if (t.header.some((h) => h === '' || h.length > 40 || /[()={}[\];:]/.test(h))) return undefined;
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  if (lines.some((l) => l.trimEnd().endsWith(delimiter))) return undefined;
  const numeric = numericColumns(t).some(Boolean);
  if (!numeric && t.header.length < 3) return undefined;
  return t;
}
