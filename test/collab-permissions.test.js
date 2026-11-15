import { describe, it, expect } from 'vitest';
import {
  classifyChange, allowedChange, pythonRegions, latexProjection, fileKind,
} from '../js/collab/permissions.js';

const DOC = [
  '\\documentclass{article}',
  '\\begin{document}',
  '%#python id=a1',
  'x = 2',
  '%#end',
  'El valor es \\py{x} y \\pyif{x > 1}{grande}{pequeño}.',
  '\\end{document}',
  '',
].join('\n');

const LATEX = { python: false, latex: true };
const PY = { python: true, latex: false };
const edit = (from, to, insert, text = DOC) => text.slice(0, from) + insert + text.slice(to);
const at = (needle, text = DOC) => text.indexOf(needle);

describe('collab · qué es Python y qué es LaTeX', () => {
  it('editar prosa es LaTeX', () => {
    const a = edit(at('El valor'), at('El valor') + 2, 'Su');
    expect(classifyChange(DOC, a, 'm.pltx')).toEqual({ python: false, latex: true });
  });

  it('editar una celda es Python', () => {
    const a = edit(at('x = 2'), at('x = 2') + 5, 'x = 3');
    expect(classifyChange(DOC, a, 'm.pltx')).toEqual({ python: true, latex: false });
  });

  it('\\py{} y la condición de \\pyif son Python; sus ramas son LaTeX', () => {
    expect(classifyChange(DOC, edit(at('\\py{x}') + 4, at('\\py{x}') + 5, 'x*2'), 'm.pltx').python).toBe(true);
    expect(classifyChange(DOC, edit(at('x > 1'), at('x > 1') + 5, 'x > 9'), 'm.pltx').python).toBe(true);
    const branch = classifyChange(DOC, edit(at('grande'), at('grande') + 6, 'enorme'), 'm.pltx');
    expect(branch).toEqual({ python: false, latex: true });
  });

  it('crear una celda nueva es Python (y no toca el LaTeX si va a principio de línea)', () => {
    const a = edit(at('\\end{document}'), at('\\end{document}'), '%#python\nimport os\n%#end\n');
    expect(classifyChange(DOC, a, 'm.pltx')).toEqual({ python: true, latex: false });
  });

  it('unir líneas para que un comentario se convierta en celda es Python', () => {
    const t = DOC.replace('\\end{document}', 'fin %#python\nimport os\n%#end\n\\end{document}');
    const i = t.indexOf('fin ') + 4; // delete "fin " so %#python starts the line
    const a = t.slice(0, t.indexOf('fin ')) + t.slice(i);
    expect(classifyChange(t, a, 'm.pltx').python).toBe(true);
  });

  it('borrar %#end o envolver la celda en verbatim es Python', () => {
    const noEnd = DOC.replace('%#end\n', '');
    expect(classifyChange(DOC, noEnd, 'm.pltx').python).toBe(true);
    const verb = DOC.replace('%#python id=a1', '\\begin{verbatim}\n%#python id=a1').replace('%#end', '%#end\n\\end{verbatim}');
    expect(classifyChange(DOC, verb, 'm.pltx').python).toBe(true);
  });

  it('cuenta como Python todo lo que el compilador ejecutaría, escrito como sea', () => {
    // The compiler evaluates "\\py{…}" too (it does not look at the backslash
    // before): typing either form is a Python change.
    for (const ins of ['\\py{os.system(1)} ', '\\\\py{os.system(1)} ']) {
      const a = edit(at('El valor'), at('El valor'), ins);
      expect(classifyChange(DOC, a, 'm.pltx').python).toBe(true);
    }
    // Completing a \py{ whose brace was left open is Python as well.
    const open = DOC.replace('El valor', 'Ojo \\py{os.system(1) El valor');
    const closed = open.replace('os.system(1) ', 'os.system(1)} ');
    expect(classifyChange(open, closed, 'm.pltx').python).toBe(true);
  });

  it('\\pyfile y \\pynotebook son Python', () => {
    const a = edit(at('\\end{document}'), at('\\end{document}'), '\\pyfile{malo.py}\n');
    expect(classifyChange(DOC, a, 'm.pltx').python).toBe(true);
  });

  it('un .tex es todo LaTeX; un .py es todo Python', () => {
    expect(fileKind('cap.tex')).toBe('latex');
    expect(fileKind('calc.py')).toBe('python');
    expect(classifyChange('a', 'b', 'cap.tex')).toEqual({ python: false, latex: true });
    expect(classifyChange('a', 'b', 'calc.py')).toEqual({ python: true, latex: false });
  });

  it('allowedChange aplica los permisos', () => {
    const prose = edit(at('El valor'), at('El valor') + 2, 'Su');
    const code = edit(at('x = 2'), at('x = 2') + 5, 'x = 3');
    expect(allowedChange(DOC, prose, 'm.pltx', LATEX).ok).toBe(true);
    expect(allowedChange(DOC, code, 'm.pltx', LATEX)).toEqual({ ok: false, why: 'python' });
    expect(allowedChange(DOC, code, 'm.pltx', PY).ok).toBe(true);
    expect(allowedChange(DOC, prose, 'm.pltx', PY)).toEqual({ ok: false, why: 'latex' });
    expect(allowedChange(DOC, prose, 'm.pltx', { python: false, latex: false }).ok).toBe(false);
  });

  it('las regiones cubren la celda entera y el resto queda como LaTeX', () => {
    const r = pythonRegions(DOC);
    expect(DOC.slice(r[0][0], r[0][1])).toBe('%#python id=a1\nx = 2\n%#end\n');
    expect(latexProjection(DOC)).not.toContain('x = 2');
    expect(latexProjection(DOC)).toContain('{grande}{pequeño}');
  });

  it('es rápido en un documento grande', () => {
    const big = Array.from({ length: 4000 }, (_, i) => (i % 40 === 0
      ? `%#python\ny${i} = ${i}\n%#end` : `Párrafo ${i} con \\py{y0} y texto normal de relleno para ocupar.`)).join('\n');
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) classifyChange(big, big + 'x', 'm.pltx');
    expect((performance.now() - t0) / 10).toBeLessThan(60);
  });
});
