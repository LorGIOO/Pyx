// \begin / \end in the editor with ONE cursor: Enter never splits a name nor
// adds a second \end, and renaming either name renames the other. The bug
// these guard against: the generic "\begin{ }" completion left two cursors
// (one per name) and, after Enter, everything typed came out twice.
import { describe, it, expect } from 'vitest';
import { EditorState, EditorSelection } from '@codemirror/state';
import { indentUnit } from '@codemirror/language';
import {
  envNameAt, matchingEnd, matchingBegin, envIsClosed, blankComments, envEnter, envTab, insertEnvSkeleton,
  envRenameFilter,
} from '../js/editor/latex-env.js';

const latexExtras = [envRenameFilter()];

/** A minimal view: the real state machinery (filters included), no DOM. */
function fakeView(textWithCursor, extensions = []) {
  const at = textWithCursor.indexOf('|');
  const view = {
    state: EditorState.create({
      doc: textWithCursor.replace('|', ''),
      selection: EditorSelection.cursor(at),
      extensions: [indentUnit.of('  '), EditorState.allowMultipleSelections.of(true), ...extensions],
    }),
    dispatch(spec) { view.state = view.state.update(spec).state; },
  };
  return view;
}
const shown = (v) => {
  const s = v.state.doc.toString();
  const h = v.state.selection.main.head;
  return s.slice(0, h) + '|' + s.slice(h);
};
const type = (v, text) => {
  for (const ch of text) {
    const h = v.state.selection.main.head;
    v.dispatch({ changes: { from: h, insert: ch }, selection: { anchor: h + 1 }, userEvent: 'input.type' });
  }
};

describe('dónde está el nombre de un entorno', () => {
  it('\\begin y \\end, con el cursor dentro de las llaves', () => {
    const line = '  \\begin{itemize} y \\end{tabla}';
    expect(envNameAt(line, line.indexOf('item') + 2)).toMatchObject({ kind: 'begin', name: 'itemize' });
    expect(envNameAt(line, line.indexOf('tabla'))).toMatchObject({ kind: 'end', name: 'tabla' });
    expect(envNameAt(line, 0)).toBe(null);
    expect(envNameAt('\\begin{}', 7)).toMatchObject({ name: '', from: 7, to: 7 });
  });
  it('el \\begin que abre un \\end, con anidados del mismo nombre', () => {
    const t = '\\begin{a}\n\\begin{a}\\end{a}\n\\end{a}';
    const last = t.lastIndexOf('\\end');
    expect(matchingBegin(t, last, 'a').from).toBe('\\begin{'.length);
    expect(matchingEnd(t, '\\begin{a}'.length, 'a').from).toBe(t.lastIndexOf('a}'));
  });
  it('un \\end comentado no cierra nada; \\% no es un comentario', () => {
    expect(blankComments('a % b\nc')).toBe('a    \nc');
    expect(blankComments('50\\% x')).toBe('50\\% x');
    const t = '\\begin{x}\n% \\end{x}\n';
    expect(envIsClosed(t, '\\begin{x}'.length, 'x')).toBe(false);
  });
  it('un \\begin nuevo dentro de otro del mismo nombre sigue abierto', () => {
    const t = '\\begin{itemize}\n\\begin{itemize}\n\\end{itemize}';
    const inner = t.indexOf('\\begin{itemize}', 2) + '\\begin{itemize}'.length;
    expect(envIsClosed(t, inner, 'itemize')).toBe(false);
    expect(envIsClosed('\\begin{x}\n\\end{x}', '\\begin{x}'.length, 'x')).toBe(true);
  });
});

describe('Intro en la línea del \\begin', () => {
  it('al final de \\begin{x} sin cerrar: cuerpo y \\end', () => {
    const v = fakeView('\\begin{itemize}|');
    expect(envEnter(v)).toBe(true);
    expect(shown(v)).toBe('\\begin{itemize}\n  |\n\\end{itemize}');
  });
  it('al final de \\begin{x} YA cerrado: solo el cuerpo, ningún \\end de más', () => {
    const v = fakeView('\\begin{itemize}|\n\\end{itemize}');
    expect(envEnter(v)).toBe(true);
    expect(shown(v)).toBe('\\begin{itemize}\n  |\n\\end{itemize}');
  });
  it('con argumentos: \\begin{tabular}{lr} y \\begin{figure}[htbp]', () => {
    const v = fakeView('\\begin{tabular}{lr}|');
    envEnter(v);
    expect(v.state.doc.toString()).toBe('\\begin{tabular}{lr}\n  \n\\end{tabular}');
    const f = fakeView('\\begin{figure}[htbp]|');
    envEnter(f);
    expect(f.state.doc.toString()).toBe('\\begin{figure}[htbp]\n  \n\\end{figure}');
  });
  it('con el cursor DENTRO del nombre: no parte la línea, entra en el cuerpo', () => {
    const v = fakeView('\\begin{mid|ef}\n  \n\\end{midef}');
    expect(envEnter(v)).toBe(true);
    expect(shown(v)).toBe('\\begin{midef}\n  |\n\\end{midef}');
    const w = fakeView('\\begin{midef|}\n\\end{midef}');
    envEnter(w);
    expect(shown(w)).toBe('\\begin{midef}\n  |\n\\end{midef}');
  });
  it('dentro del nombre de uno sin cerrar: lo cierra y entra', () => {
    const v = fakeView('\\begin{cases|}');
    envEnter(v);
    expect(shown(v)).toBe('\\begin{cases}\n  |\n\\end{cases}');
  });
  it('respeta la sangría de la línea', () => {
    const v = fakeView('    \\begin{enumerate}|');
    envEnter(v);
    expect(v.state.doc.toString()).toBe('    \\begin{enumerate}\n      \n    \\end{enumerate}');
  });
  it('\\begin{document} y varios cursores: no lo toca', () => {
    expect(envEnter(fakeView('\\begin{document}|'))).toBe(false);
    const v = fakeView('\\begin{a|}');
    v.state = v.state.update({ selection: EditorSelection.create([EditorSelection.cursor(7), EditorSelection.cursor(8)]) }).state;
    expect(envEnter(v)).toBe(false);
  });
  it('Tab dentro del nombre hace lo mismo que Intro', () => {
    const v = fakeView('\\begin{ali|gn}\n\\end{align}');
    expect(envTab(v)).toBe(true);
    expect(shown(v)).toBe('\\begin{align}\n  |\n\\end{align}');
    expect(envTab(fakeView('texto| normal'))).toBe(false);
  });
});

describe('el entorno genérico «\\begin{ }»: un solo cursor', () => {
  it('escribir el nombre lo copia en el \\end; Intro entra en el cuerpo; nada se duplica', () => {
    const v = fakeView('Texto\n\\begin|', latexExtras);
    const from = v.state.doc.toString().indexOf('\\begin');
    insertEnvSkeleton(v, from, v.state.selection.main.head);
    expect(v.state.selection.ranges).toHaveLength(1);
    expect(shown(v)).toBe('Texto\n\\begin{|}\n  \n\\end{}');
    type(v, 'midef');
    expect(shown(v)).toBe('Texto\n\\begin{midef|}\n  \n\\end{midef}');
    expect(envEnter(v)).toBe(true);
    type(v, 'hola');
    expect(v.state.doc.toString()).toBe('Texto\n\\begin{midef}\n  hola\n\\end{midef}');
    expect(v.state.selection.ranges).toHaveLength(1);
  });
});

describe('renombrar un nombre renombra el otro', () => {
  it('del \\begin al \\end, y del \\end al \\begin', () => {
    const v = fakeView('\\begin{itemize|}\n\\item a\n\\end{itemize}', latexExtras);
    type(v, 'x');
    expect(v.state.doc.toString()).toBe('\\begin{itemizex}\n\\item a\n\\end{itemizex}');
    const w = fakeView('\\begin{tabla}\nx\n\\end{tabla|}', latexExtras);
    type(w, 's');
    expect(w.state.doc.toString()).toBe('\\begin{tablas}\nx\n\\end{tablas}');
  });
  it('con anidados del mismo nombre, solo su pareja', () => {
    const v = fakeView('\\begin{a}\n\\begin{a|}\n\\end{a}\n\\end{a}', latexExtras);
    type(v, 'b');
    expect(v.state.doc.toString()).toBe('\\begin{a}\n\\begin{ab}\n\\end{ab}\n\\end{a}');
  });
});
