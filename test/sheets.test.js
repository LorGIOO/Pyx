// \hoja / \celda: requests, LaTeX of the values, substitution.
import { describe, it, expect } from 'vitest';
import { sheetRequests, resolveSheets, gridTeX, cellTeX, findSheetCommands } from '../js/compile/sheets.js';

describe('\\hoja y \\celda', () => {
  it('cada \\celda usa el \\hoja vigente, con su hoja y la transposición', () => {
    const t = '\\hoja[Datos]{a.xlsx}\n\\celda{E4} \\celda[T]{E4:E8}\n\\hoja{b.csv}\\celda{B2}';
    const { reqs } = sheetRequests(t);
    expect(reqs.map((r) => [r.link.path, r.link.sheet, r.ref, r.transpose])).toEqual([
      ['a.xlsx', 'Datos', 'E4', false], ['a.xlsx', 'Datos', 'E4:E8', true], ['b.csv', '', 'B2', false],
    ]);
  });
  it('un capítulo sin \\hoja propio hereda el del documento principal', () => {
    const { reqs } = sheetRequests('\\celda{A1}', { path: 'x.xlsx', sheet: 'H' });
    expect(reqs[0].link).toEqual({ path: 'x.xlsx', sheet: 'H' });
  });
  it('no cuenta lo comentado ni lo que está en verbatim', () => {
    expect(findSheetCommands('% \\celda{A1}\n\\begin{verbatim}\n\\celda{A2}\n\\end{verbatim}\n\\celda{A3}').map((c) => c.arg)).toEqual(['A3']);
  });
  it('escribe una celda, una fila, una columna y una tabla en una sola línea', () => {
    expect(gridTeX([[12.5]])).toBe('12.5');
    expect(gridTeX([[1, 2, 3]])).toBe('1 & 2 & 3');
    expect(gridTeX([[1], [2]])).toBe('1 \\\\ 2 \\\\');
    expect(gridTeX([[1], [2]], true)).toBe('1 & 2');
    expect(gridTeX([['a', 1], ['b', 2]])).toBe('a & 1 \\\\ b & 2 \\\\');
    expect(cellTeX(0.1 + 0.2)).toBe('0.3');
    expect(cellTeX('I+D & Co_1')).toBe('I+D \\& Co\\_1');
    expect(cellTeX(null)).toBe('');
  });
  it('sustituye las celdas y avisa de las que no se pueden leer', () => {
    const t = '\\hoja{a.csv}x = \\celda{B2}, y = \\celda{ZZ}.';
    const r = resolveSheets(t, null, (q) => (q.ref === 'B2' ? { ok: true, tex: '7' } : { ok: false, error: 'no es una dirección' }));
    expect(r.text).toBe('\\hoja{a.csv}x = 7, y = .');
    expect(r.problems[0].message).toContain('\\celda{ZZ}: no es una dirección');
  });
});
