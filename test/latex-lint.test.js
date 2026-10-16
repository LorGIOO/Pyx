import { describe, it, expect } from 'vitest';
import { lintLatex } from '../js/editor/latex-lint.js';

const rules = (t) => lintLatex(t).map((d) => `${d.rule}@${t.slice(d.from, d.to)}`);
const doc = (body) => `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;

describe('lintLatex: un documento correcto no da avisos', () => {
  it('nada que decir', () => {
    expect(lintLatex(doc([
      '\\section{Uno}\\label{s:1}',
      'Ver \\ref{s:1} y \\eqref{eq:a}. Un 50\\% y llaves \\{ escapadas \\}.',
      '\\begin{equation}E=mc^2\\label{eq:a}\\end{equation}',
      'Inline $a+b$ y display $$x$$ y \\(y\\) y \\[z\\].',
      '% un comentario con { y \\begin{itemize} y $',
      '\\verb|{$| y \\lstinline{x{} y \\py{f"{x:.2f} $"}',
      '\\begin{verbatim}',
      '\\begin{itemize} { $ sin cerrar',
      '\\end{verbatim}',
      '%#python',
      'd = {"a": 1}  # { sin cerrar en Python es asunto de Python',
      '%#end',
      '\\cref{s:1,eq:a}',
      '\\item $100! \\mod 97 = \\py{math.factorial(100) % 97}$',
    ].join('\n')))).toEqual([]);
  });
});

describe('lintLatex: errores de estructura', () => {
  it('llaves', () => {
    expect(rules(doc('\\textbf{hola'))).toEqual(['brace@{']);
    expect(rules(doc('hola}'))).toEqual(['brace@}']);
  });
  it('entornos', () => {
    expect(rules(doc('\\begin{itemize}\n\\item a'))).toEqual(['env@\\begin{itemize}']);
    expect(rules(doc('\\begin{itemize}\\item a\\end{enumerate}'))).toEqual(['env@\\begin{itemize}', 'env@\\end{enumerate}']);
    expect(rules('\\documentclass{article}\n\\begin{document}\nTexto\n')).toEqual(['env@\\begin{document}']);
  });
  it('etiquetas y referencias', () => {
    expect(rules(doc('\\label{a}\\label{a}'))).toEqual(['label@\\label{a}']);
    expect(rules(doc('Ver \\ref{nada} y \\cref{x,y}\\label{x}'))).toEqual(['ref@nada', 'ref@y']);
    // A chapter of a bigger document: its labels may live elsewhere.
    expect(rules(doc('\\input{cap1}\nVer \\ref{nada}'))).toEqual([]);
  });
  it('entornos verbatim definidos por el documento', () => {
    const t = '\\documentclass{article}\n\\lstnewenvironment{codigo}{}{}\n\\begin{document}\n'
      + '\\begin{codigo}\nx = {1: 2\n\\begin{itemize}\n\\end{codigo}\n\\end{document}\n';
    expect(rules(t)).toEqual([]);
  });
  it('fórmula sin cerrar', () => {
    expect(rules(doc('El valor $x + 1 es\n\notro párrafo.'))).toEqual(['math@$']);
  });
});
