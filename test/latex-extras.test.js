// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { mathAt, printableTex, refKeyAt, matchingEnd } from '../js/editor/latex-extras.js';

const at = (text, marker) => mathAt(text.replace('|', ''), text.indexOf('|'));

describe('mathAt: la fórmula bajo el ratón', () => {
  it('en línea, con $ y con \\(…\\)', () => {
    expect(at('El área $A = \\pi r|^2$ vale', '|')).toMatchObject({ tex: 'A = \\pi r^2', display: false });
    expect(at('y \\(x+|1\\) aquí', '|')).toMatchObject({ tex: 'x+1', display: false });
    expect(at('precio \\$5 y $a|+b$', '|')).toMatchObject({ tex: 'a+b' });
    expect(at('fuera $a$ de| la fórmula $b$', '|')).toBe(null);
  });
  it('entornos y \\[…\\], también de varias líneas', () => {
    const r = at('\\begin{align}\n  a &= b \\label{e1}\\\\\n  c &= |d\n\\end{align}', '|');
    expect(r.display).toBe(true);
    expect(r.tex.startsWith('\\begin{align}')).toBe(true);
    expect(at('Texto \\[ E = m|c^2 \\] fin', '|')).toMatchObject({ tex: ' E = mc^2 ', display: true });
    expect(at('\\begin{equation*}x|\\end{equation*}', '|').tex).toBe('\\begin{equation*}x\\end{equation*}');
  });
});

describe('printableTex: la fórmula tal como se imprimirá', () => {
  it('quita las etiquetas y pone el valor de cada \\py{}', () => {
    const v = { L: '6.5', 'round(A, 2)': '\\ensuremath{3.14}' };
    expect(printableTex('L = \\py{L}\\label{eq:l} \\nonumber', (e) => v[e] ?? null)).toBe('L = {6.5} ');
    expect(printableTex('A = \\py{round(A, 2)}', (e) => v[e] ?? null)).toBe('A = {3.14}');
    expect(printableTex('q = \\py{q_k}', () => null)).toBe('q = {\\boxed{\\texttt{qk}}}');
  });
});

describe('refKeyAt y matchingEnd', () => {
  it('la etiqueta bajo el cursor, también en listas de \\cref', () => {
    const line = 'Ver \\ref{fig:a} y \\cref{eq:1,eq:2}.';
    expect(refKeyAt(line, line.indexOf('fig:a') + 2)).toBe('fig:a');
    expect(refKeyAt(line, line.indexOf('eq:2') + 1)).toBe('eq:2');
    expect(refKeyAt(line, 1)).toBe(null);
  });
  it('el \\end que cierra este \\begin, con anidados del mismo nombre', () => {
    const t = '\\begin{itemize}\n\\begin{itemize}\\end{itemize}\n\\end{itemize}';
    const end = matchingEnd(t, '\\begin{itemize}'.length, 'itemize');
    expect(end.from).toBe(t.lastIndexOf('itemize'));
  });
});

describe('compileDiagnostics: los errores de la última compilación en su línea', () => {
  it('solo los del archivo abierto, en la línea que dice el registro', async () => {
    const { EditorState } = await import('@codemirror/state');
    const { setProblemsSource, compileDiagnostics } = await import('../js/editor/latex-extras.js');
    setProblemsSource(() => [
      { severity: 'error', file: 'C:\\proj\\informe.pltx', line: 2, message: 'Undefined control sequence.' },
      { severity: 'warning', file: 'C:\\proj\\cap1.tex', line: 1, message: 'Otro archivo' },
      { severity: 'badbox', file: 'C:\\proj\\informe.pltx', line: 99, message: 'Fuera del documento' },
    ]);
    const state = EditorState.create({ doc: 'uno\n\\foo dos\ntres' });
    const d = compileDiagnostics({ state }, 'C:/proj/informe.pltx');
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ severity: 'error', from: 4, to: 12 });
    expect(d[0].message).toContain('Undefined control sequence.');
  });
});
