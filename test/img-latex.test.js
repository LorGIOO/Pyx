// Where a recognized formula lands: inside mathematics it must go in bare
// (delimiters inside delimiters break the compile); outside, with the ones
// Configuración asks for.

import { describe, it, expect } from 'vitest';
import { inMath, formulaInsert } from '../js/editor/formula-place.js';

const at = (text) => inMath(text, text.length);

describe('imagen → LaTeX: dónde se escribe la fórmula', () => {
  it('texto normal: fuera de matemáticas', () => {
    expect(at('La altura de ola es ')).toBe(false);
    expect(at('Cuesta 5\\$ y ')).toBe(false);          // \$ no abre nada
    expect(at('$a$ y $b$ y ')).toBe(false);
    expect(at('% un $ en un comentario\nTexto ')).toBe(false);
  });
  it('dentro de $…$, \\(…\\) y \\[…\\]', () => {
    expect(at('La altura $H_s = ')).toBe(true);
    expect(at('La altura \\( H_s = ')).toBe(true);
    expect(at('\\[\n  H_s = ')).toBe(true);
    expect(at('\\[ a \\]\nTexto ')).toBe(false);
  });
  it('dentro de un entorno matemático, aunque haya párrafos de por medio', () => {
    expect(at('\\begin{align}\n a &= b \\\\\n\n ')).toBe(true);
    expect(at('\\begin{equation*}\n x ')).toBe(true);
    expect(at('\\begin{equation}\n x \n\\end{equation}\nTexto ')).toBe(false);
  });
  it('un $ de un párrafo anterior no cuenta', () => {
    expect(at('Precio: 3 $ de más.\n\nNuevo párrafo ')).toBe(false);
  });

  it('fuera de matemáticas: fórmula independiente, en línea o tal cual', () => {
    expect(formulaInsert('x^2', { mode: 'display', lineStart: true })).toBe('\\[\n  x^2\n\\]\n');
    expect(formulaInsert('x^2', { mode: 'display', lineStart: false })).toBe('\n\\[\n  x^2\n\\]\n');
    expect(formulaInsert('x^2', { mode: 'inline' })).toBe('$x^2$');
    expect(formulaInsert('x^2', { mode: 'raw' })).toBe('x^2');
  });
  it('dentro de matemáticas: siempre tal cual', () => {
    expect(formulaInsert('\\frac{a}{b}', { math: true, mode: 'display' })).toBe('\\frac{a}{b}');
  });
  it('quita los delimitadores que traiga el reconocedor', () => {
    expect(formulaInsert('$$ a+b $$', { mode: 'inline' })).toBe('$a+b$');
    expect(formulaInsert('\\[ a+b \\]', { mode: 'raw' })).toBe('a+b');
    expect(formulaInsert(' $a+b$ ', { math: true })).toBe('a+b');
  });
});
