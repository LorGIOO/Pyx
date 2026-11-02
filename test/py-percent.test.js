// A `%` inside \py{…} is Python (a format, the modulo operator), not a LaTeX
// comment — for the compiler, the editor's coloring and every other layer.
import { describe, it, expect } from 'vitest';
import { findPyExprs, findPyIfExprs, stripTexComment, texCommentStart, inTexComment } from '../js/compile/latex-bridge.js';

const CSV = String.raw`\py{df.head(20).to_csv(sep="&", header=False, index=False, float_format="%.6f", lineterminator=" \\\\\n")}`;

describe('% dentro de \\py{}', () => {
  it('no empieza un comentario', () => {
    expect(texCommentStart(CSV)).toBe(-1);
    expect(texCommentStart(String.raw`El resto es \py{n % 97} y sigue`)).toBe(-1);
    expect(texCommentStart(String.raw`\pyif{n % 2 == 0}{par}{impar} % nota`)).toBe(String.raw`\pyif{n % 2 == 0}{par}{impar} `.length);
    expect(stripTexComment(String.raw`\py{f"{x:.1%}"} % comentario`)).toBe(String.raw`\py{f"{x:.1%}"} `);
  });

  it('el compilador lee la expresión entera', () => {
    const [e] = findPyExprs(CSV);
    expect(e.expr).toBe(String.raw`df.head(20).to_csv(sep="&", header=False, index=False, float_format="%.6f", lineterminator=" \\\\\n")`);
  });

  it('un \\py{} comentado no se evalúa; \\% sigue siendo un porcentaje', () => {
    expect(findPyExprs('% \\py{no}\nsí \\py{a}').map((e) => e.expr)).toEqual(['a']);
    expect(findPyExprs('50\\% de \\py{b}').map((e) => e.expr)).toEqual(['b']);
    expect(findPyExprs('\\py{"%d" % 3} y \\py{c} % \\py{d}').map((e) => e.expr)).toEqual(['"%d" % 3', 'c']);
    expect(findPyIfExprs('% \\pyif{x}{a}{b}')).toEqual([]);
    expect(inTexComment('texto % \\py{x}', 8)).toBe(true);
  });
});
