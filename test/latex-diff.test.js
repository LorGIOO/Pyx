import { describe, it, expect } from 'vitest';
import { latexDiff, flatten, escapeTeX, pythonCellsAppendix, DIFF_STYLES } from '../js/compile/latex-diff.js';

const doc = (body, pre = '') => `\\documentclass{article}\n${pre}\\begin{document}\n${body}\n\\end{document}\n`;

describe('latexDiff', () => {
  it('marks added and deleted words', () => {
    const { text, stats } = latexDiff(doc('El perro come pan.'), doc('El gato come pan.'));
    expect(text).toMatch(/\\DIFdel\{perro\}/);
    expect(text).toMatch(/\\DIFadd\{gato\}/);
    expect(stats.add).toBeGreaterThan(0);
    expect(stats.del).toBeGreaterThan(0);
  });
  it('uses the new preamble and defines the markers for every style', () => {
    for (const style of DIFF_STYLES) {
      const { text } = latexDiff(doc('a'), doc('b', '\\usepackage{amsmath}\n'), { style });
      expect(text).toContain('\\usepackage{amsmath}');
      expect(text).toMatch(/\\providecommand\{\\DIFadd\}|\\newcommand\{\\DIFadd\}|\\DeclareRobustCommand\{\\DIFadd\}|\\def\\DIFadd/);
      expect(text.indexOf('\\DIFadd')).toBeLessThan(text.indexOf('\\begin{document}'));
    }
  });
  it('identical documents give no changes', () => {
    const { stats } = latexDiff(doc('Igual.'), doc('Igual.'));
    expect(stats).toEqual({ add: 0, del: 0 });
  });
  it('goes into the text arguments of a command', () => {
    const { text } = latexDiff(doc('\\section{Uno dos}'), doc('\\section{Uno tres}'));
    expect(text).toMatch(/\\section\[Uno tres\]\{Uno [^\n]*\\DIFadd\{tres\}/);
  });
  it('keeps the new Python cells and lists their changes at the end', () => {
    const o = doc('%#python\nx = 1\n%#end\nTexto.');
    const n = doc('%#python\nx = 2\n%#end\nTexto.');
    const { text } = latexDiff(o, n, { cells: true });
    expect(text).toContain('x = 2');
    expect(pythonCellsAppendix(o, n)).toMatch(/x = 1/);
  });
});

describe('helpers', () => {
  it('escapes TeX specials', () => {
    expect(escapeTeX('a_b & 50%')).toBe('a\\_b \\& 50\\%');
  });
  it('flattens \\input, skipping commented ones', async () => {
    const files = { '/p/cap.tex': 'Capítulo.' };
    const read = async (p) => { if (p in files) return files[p]; throw new Error('no'); };
    const join = (d, f) => `${d}/${f}`;
    const out = await flatten('A \\input{cap}\n% \\input{cap}\nB', '/p', read, join);
    expect(out).toContain('Capítulo.');
    expect(out).toContain('% \\input{cap}');
  });
});
