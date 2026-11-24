import { describe, it, expect } from 'vitest';
import { chooseEngine, requiredEngine, engineShim } from '../js/compile/engine.js';
import { parseLatexLog as parseLog } from '../js/compile/log-parser.js';

const CV = '\\documentclass{article}\n\\input glyphtounicode\n\\pdfgentounicode=1\n\\begin{document}x\\end{document}';
const FS = '\\documentclass{article}\n\\usepackage{fontspec}\n\\begin{document}x\\end{document}';
const ALL = ['xelatex', 'pdflatex', 'lualatex'];

describe('choosing the engine', () => {
  it('reads what the source needs (comments do not count)', () => {
    expect(requiredEngine(CV).engine).toBe('pdflatex');
    expect(requiredEngine(FS).engine).toBe('xelatex');
    expect(requiredEngine('\\directlua{tex.print(1)}').engine).toBe('lualatex');
    expect(requiredEngine('% \\usepackage{fontspec}\n\\documentclass{article}')).toBeNull();
  });
  it('document choice > magic line > need > default > first installed', () => {
    expect(chooseEngine({ docEngine: 'lualatex', rootText: CV, defaultEngine: 'xelatex', installed: ALL }).engine).toBe('lualatex');
    expect(chooseEngine({ rootText: '% !TeX program = xelatex\n' + CV, installed: ALL }).engine).toBe('xelatex');
    expect(chooseEngine({ rootText: CV, defaultEngine: 'xelatex', installed: ALL }).engine).toBe('pdflatex');
    expect(chooseEngine({ rootText: FS, defaultEngine: 'pdflatex', installed: ALL }).engine).toBe('xelatex');
    expect(chooseEngine({ rootText: 'x', defaultEngine: 'pdflatex', installed: ALL }).engine).toBe('pdflatex');
    expect(chooseEngine({ rootText: 'x', installed: ['xelatex', 'pdflatex'] }).engine).toBe('xelatex');
  });
  it('an engine that is not installed is replaced, and said so', () => {
    const r = chooseEngine({ rootText: CV, installed: ['tectonic'] });
    expect(r.engine).toBe('tectonic');
    expect(r.note).toBe('pdflatex → tectonic');
  });
  it('pdfTeX primitives become no-ops for the other engines, on one line', () => {
    expect(engineShim('pdflatex', CV)).toBe('');
    const s = engineShim('xelatex', CV);
    expect(s).toContain('\\def\\pdfglyphtounicode#1#2{}');
    expect(s).not.toContain('\n');
    expect(engineShim('xelatex', FS)).toBe('');
  });
  it('the engines\' own fatal errors reach the problems list', () => {
    const items = parseLog('!pdfTeX error: pdflatex (file SourceSansPro-Regular-tlf-t1): Font SourceSansPro-Regular-tlf-t1 at 600 not found\n ==> Fatal error occurred, no output PDF file produced!\n');
    expect(items.some((i) => i.severity === 'error' && /SourceSansPro/.test(i.message))).toBe(true);
  });
});
