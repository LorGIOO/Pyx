// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { parseTsv, parseHtmlTable, rowsToTabular, escapeCell } from '../js/editor/paste-table.js';

describe('paste a table as a tabular', () => {
  it('reads what Excel puts on the clipboard, quoted cells included', () => {
    expect(parseTsv('Viga\tL (m)\tq\nV1\t5,5\t10\nV2\t"a\tb"\t12\n')).toEqual([
      ['Viga', 'L (m)', 'q'], ['V1', '5,5', '10'], ['V2', 'a\tb', '12'],
    ]);
  });

  it('a paragraph with a stray tab is not a table', () => {
    expect(parseTsv('una línea\totra cosa\nsin tabuladores\ntampoco\naquí')).toBeNull();
    expect(parseTsv('sin tabuladores')).toBeNull();
  });

  it('builds the tabular: numbers right, text left, escaped, rules', () => {
    const t = rowsToTabular([['Elemento', 'M (kN·m)'], ['Viga_1', '12,5'], ['50% & más', '7']]);
    expect(t).toContain('\\begin{tabular}{lr}');
    expect(t).toContain('Viga\\_1 & 12,5 \\\\');
    expect(t).toContain('50\\% \\& más & 7 \\\\');
    expect(t.match(/\\hline/g)).toHaveLength(3);
    expect(rowsToTabular([['a', 'b'], ['1', '2']], { booktabs: true })).toContain('\\toprule');
  });

  it('reads HTML tables, merged cells as \\multicolumn', () => {
    const rows = parseHtmlTable('<table><tr><th colspan="2">Cargas</th></tr><tr><td>G</td><td>3</td></tr></table>');
    expect(rows[0]).toEqual([{ text: 'Cargas', span: 2 }]);
    expect(rowsToTabular(rows)).toContain('\\multicolumn{2}{c}{Cargas} \\\\');
  });

  it('escapes every LaTeX special character', () => {
    expect(escapeCell('a_b#c$d{e}~^\\')).toBe('a\\_b\\#c\\$d\\{e\\}\\textasciitilde{}\\textasciicircum{}\\textbackslash{}');
  });
});
