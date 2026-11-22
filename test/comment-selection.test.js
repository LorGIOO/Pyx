// @vitest-environment jsdom
// Ctrl+T with a word or phrase selected comments only that, not the line.
import { describe, it, expect } from 'vitest';
import { EditorState, EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { toggleLineComment } from '../js/editor/commands.js';

const view = (doc, from, to) => new EditorView({
  state: EditorState.create({ doc, selection: EditorSelection.single(from, to) }),
  parent: document.body,
});
const sel = (doc, word) => [doc.indexOf(word), doc.indexOf(word) + word.length];

describe('Ctrl+T con una selección dentro de la línea', () => {
  it('comenta solo lo seleccionado y pasa el resto a la línea siguiente', () => {
    const doc = 'La viga es de acero S275 y cumple.';
    const v = view(doc, ...sel(doc, 'de acero S275'));
    toggleLineComment(v);
    expect(v.state.doc.toString()).toBe('La viga es %de acero S275\n y cumple.');
  });
  it('al final de la línea solo añade el %', () => {
    const doc = 'texto final';
    const v = view(doc, ...sel(doc, 'final'));
    toggleLineComment(v);
    expect(v.state.doc.toString()).toBe('texto %final');
  });
  it('otra vez Ctrl+T lo descomenta', () => {
    const doc = 'La viga es de acero';
    const v = view(doc, ...sel(doc, 'de acero'));
    toggleLineComment(v);
    toggleLineComment(v);
    expect(v.state.doc.toString()).toBe('La viga es de acero');
  });
  it('sin selección, o con la línea entera, comenta la línea como siempre', () => {
    const v = view('a\nb', 0, 0);
    toggleLineComment(v);
    expect(v.state.doc.toString()).toBe('% a\nb');
    const w = view('  línea entera', 2, 14);
    toggleLineComment(w);
    expect(w.state.doc.toString()).toBe('  % línea entera');
  });
  it('en una celda de Python con código detrás, comenta la línea entera', () => {
    const doc = '%#python\nx = f(a, b)\n%#end';
    const v = view(doc, ...sel(doc, 'a,'));
    toggleLineComment(v);
    expect(v.state.doc.toString()).toBe('%#python\n# x = f(a, b)\n%#end');
  });
});
