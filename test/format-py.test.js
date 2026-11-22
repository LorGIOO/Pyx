// @vitest-environment jsdom
// Formatting a \py{} (bold, italic, colour…) wraps the whole command, like a word.
import { describe, it, expect } from 'vitest';
import { EditorState, EditorSelection } from '@codemirror/state';
import { formatRange } from '../js/editor/commands.js';

const at = (doc, from, to = from) => formatRange(EditorState.create({ doc, selection: EditorSelection.single(from, to) }));
const doc = 'La flecha es \\py{round(f, 2)} mm y \\pyif{f < 10}{cumple}{no cumple}.';
const pos = (s, k = 0) => doc.indexOf(s) + k;

describe('formato sobre \\py{}', () => {
  it('con el cursor dentro de \\py{…} se formatea el comando entero', () => {
    const r = at(doc, pos('round', 3));
    expect(doc.slice(r.from, r.to)).toBe('\\py{round(f, 2)}');
  });
  it('una selección que corta un \\py{} se amplía hasta cubrirlo', () => {
    const r = at(doc, pos('es '), pos('f, 2'));
    expect(doc.slice(r.from, r.to)).toBe('es \\py{round(f, 2)}');
  });
  it('en la condición de un \\pyif se toma el \\pyif entero; en sus textos, no', () => {
    const r = at(doc, pos('f < 10', 2));
    expect(doc.slice(r.from, r.to)).toBe('\\pyif{f < 10}{cumple}{no cumple}');
    const w = at(doc, pos('cumple}{no'), pos('cumple}{no') + 6);
    expect(doc.slice(w.from, w.to)).toBe('cumple');
  });
  it('fuera de un \\py{} no cambia nada', () => {
    const r = at(doc, pos('flecha'), pos('flecha') + 6);
    expect(doc.slice(r.from, r.to)).toBe('flecha');
  });
});
