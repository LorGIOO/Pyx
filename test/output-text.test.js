import { describe, it, expect } from 'vitest';
import { collapseCR, ansiRuns } from '../js/editor/ansi.js';
import { splitMath } from '../js/editor/math-split.js';

describe('terminal text (ansi.js)', () => {
  it('a \\r progress line shows its final state', () => {
    expect(collapseCR('paso 0\rpaso 1\rpaso 2\nfin')).toBe('paso 2\nfin');
    expect(collapseCR('  0%|   |\r100%|███|\r')).toBe('100%|███|');
    expect(collapseCR('a\r\nb')).toBe('a\nb');
    expect(collapseCR('sin retornos')).toBe('sin retornos');
  });

  it('colour codes become styled runs, not litter', () => {
    const runs = ansiRuns('\x1b[31mrojo\x1b[0m normal \x1b[1;32mverde\x1b[0m');
    expect(runs.map((r) => r.text).join('')).toBe('rojo normal verde');
    expect(runs[0].style.fg).toBe('#cd3131');
    expect(runs[1].style).toEqual({});
    expect(runs[2].style.bold).toBe(true);
    expect(runs[2].style.fg).toBe('#0dbc79');
  });

  it('256-colour and truecolour codes are understood', () => {
    expect(ansiRuns('\x1b[38;5;196mx')[0].style.fg).toMatch(/^rgb\(/);
    expect(ansiRuns('\x1b[38;2;1;2;3mx')[0].style.fg).toBe('rgb(1,2,3)');
  });

  it('other escape sequences are dropped', () => {
    expect(ansiRuns('a\x1b[2Kb\x1b]0;title\x07c').map((r) => r.text).join('')).toBe('abc');
  });
});

describe('text/latex outputs (math-split.js)', () => {
  it('handcalcs output is one display formula', () => {
    const p = splitMath('\\[\n\\begin{aligned}\na &= 2 \\\\[10pt]\n\\end{aligned}\n\\]');
    expect(p).toHaveLength(1);
    expect(p[0].type).toBe('math');
    expect(p[0].value.startsWith('\\begin{aligned}')).toBe(true);
  });

  it('sympy / IPython Math delimiters are unwrapped', () => {
    expect(splitMath('$\\displaystyle \\frac{x^{2}}{3}$')).toEqual(
      [{ type: 'math', value: '\\displaystyle \\frac{x^{2}}{3}', display: true }]);
    expect(splitMath('$$\\int x\\,dx$$')[0].value).toBe('\\int x\\,dx');
    expect(splitMath('\\(a+b\\)')[0].value).toBe('a+b');
  });

  it('text with formulas in it is split, not typeset as one formula', () => {
    const p = splitMath('La fuerza vale $F = 12$ kN y $M$ tambien');
    expect(p.map((x) => x.type)).toEqual(['text', 'math', 'text', 'math', 'text']);
    expect(p[1]).toEqual({ type: 'math', value: 'F = 12', display: false });
  });

  it('two inline formulas are not mistaken for one wrapped formula', () => {
    const p = splitMath('$a$ y $b$');
    expect(p.filter((x) => x.type === 'math').map((x) => x.value)).toEqual(['a', 'b']);
  });

  it('LaTeX without delimiters is a formula; an escaped \\$ is not a delimiter', () => {
    expect(splitMath('x^2 + 1')).toEqual([{ type: 'math', value: 'x^2 + 1', display: true }]);
    expect(splitMath('Cuesta 5 \\$ y $x$').filter((x) => x.type === 'math').map((x) => x.value))
      .toEqual(['x']);
    expect(splitMath('')).toEqual([]);
  });
});
