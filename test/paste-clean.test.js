// @vitest-environment jsdom
// Pasting: only what IS a table becomes a tabular, and nothing invisible travels.
import { describe, it, expect } from 'vitest';
import { parseTsv, parseHtmlTable, cleanPaste, freshCellIds } from '../js/editor/paste-table.js';

describe('pegar: solo lo que es una tabla, y limpio', () => {
  it('una tabla de Excel sigue siendo una tabla', () => {
    expect(parseTsv('Viga\tL (m)\nV1\t5,5\nV2\t6')).toEqual([['Viga', 'L (m)'], ['V1', '5,5'], ['V2', '6']]);
  });

  it('código con sangría de tabuladores no es una tabla', () => {
    expect(parseTsv('\\begin{table}[htbp]\n\t\\centering\n\t\\caption{Algo}\n\\end{table}')).toBeNull();
    expect(parseTsv('def f(x):\n\treturn x\n\nfor i in r:\n\tprint(i)')).toBeNull();
    expect(parseTsv('\t$i$ & $H_s$ \\\\\n\t\\hline')).toBeNull();
    expect(parseTsv('x\t= 1\ny\t= {2}')).toBeNull();
  });

  it('el código de una web (tabla de números de línea) no es una tabla', () => {
    const html = '<table class="highlight"><tr><td class="blob-num">1</td><td class="blob-code">x = 1</td></tr></table>';
    expect(parseHtmlTable(html)).toBeNull();
    expect(parseHtmlTable('<table><tr><td><pre>1</pre></td><td><pre>x = 1</pre></td></tr></table>')).toBeNull();
    expect(parseHtmlTable('<table><tr><td>a</td><td>b</td></tr></table>')).toHaveLength(1);
  });

  it('quita invisibles y ligaduras; en Python, los espacios de no separación', () => {
    expect(cleanPaste('de\u00ADfini\u200Bción ﬁnal\uFEFF')).toBe('definición final');
    expect(cleanPaste('x\u00A0=\u00A01', { python: true })).toBe('x = 1');
    expect(cleanPaste('10\u00A0m')).toBe('10\u00A0m'); // in LaTeX it means what it says
    expect(cleanPaste('a\r\nb')).toBe('a\nb');
  });

  it('una celda pegada junto a la original recibe otro id', () => {
    const text = '%#python id=abc123\nx = 1\n%#end\n%#python id=nuevo1\ny = 2\n%#end\n%#python id=nuevo1\nz = 3\n%#end';
    const out = freshCellIds(text, ['abc123']);
    expect(out).not.toContain('id=abc123');
    const ids = [...out.matchAll(/id=([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    expect(ids[1]).toBe('nuevo1');
  });
});
