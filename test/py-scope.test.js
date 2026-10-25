// \py{} between two files (or cells) that give a name different values: it
// shows the value of the NEAREST one above it.
import { describe, it, expect } from 'vitest';
import { scopeExpressions, applyScopeTags, occurrencesOf, stripScopeTag } from '../js/compile/py-scope.js';
import { pyExprBefore } from '../js/editor/py-expr.js';
import { linkInfo } from '../js/editor/notebooks.js';
import { analyzePython } from '../js/editor/py-deps.js';

const entry = (key, defs) => ({ key, info: linkInfo(defs) });

describe('el valor del archivo más próximo', () => {
  // datos.py (Hs, T) → \py{Hs} → oleaje.ipynb (Hs) → \py{Hs} → celda (Hs = …)
  const program = [
    entry('datos.py::valores', ['Hs', 'T']),
    entry('oleaje.ipynb::valores', ['Hs']),
    { key: 'doc::c1', info: analyzePython('Hs = 9.0') },
  ];
  const occ = (pos, text, start = pos * 100) => ({ path: 'doc.pltx', kind: 'py', start, end: start + text.length + 5, text, pos });

  it('cada \\py{} lee el Hs del archivo que tiene encima', () => {
    const r = scopeExpressions(program, [
      occ(0, 'Hs'), // above every definer: the final value
      occ(1, 'Hs'), // under datos.py
      occ(2, 'round(Hs * T, 2)'), // under oleaje.ipynb
      occ(3, 'Hs'), // under the cell: it is the last one, the final value is right
      occ(1, 'T'), // T has a single definer: nothing to do
    ]);
    const tags = r.tags.get('doc.pltx');
    expect(tags.map((t) => [t.text, r.scopes[t.sid]])).toEqual([
      ['Hs', { Hs: 'datos.py::valores' }],
      ['round(Hs * T, 2)', { Hs: 'oleaje.ipynb::valores' }],
    ]);
    expect([...r.captures]).toEqual([
      ['datos.py::valores', new Set(['Hs'])],
      ['oleaje.ipynb::valores', new Set(['Hs'])],
    ]);
  });

  it('sin nombres repetidos no se marca nada', () => {
    const r = scopeExpressions([entry('a::v', ['x']), entry('b::v', ['y'])], [occ(1, 'x + y')]);
    expect(r.tags.size).toBe(0);
  });

  it('las marcas se escriben en el \\py{} y en la condición del \\pyif{}, y se quitan para los mensajes', () => {
    const text = 'A \\py{Hs} y \\pyif{Hs > 2}{alto}{bajo}.';
    const tagged = applyScopeTags(text, [
      { kind: 'py', start: 2, end: 9, text: 'Hs', sid: 's1' },
      { kind: 'pyif', start: 12, end: 36, text: 'Hs > 2', sid: 's2' },
    ]);
    expect(tagged).toBe('A \\py{Hs #@s1} y \\pyif{Hs > 2 #@s2}{alto}{bajo}.');
    expect(stripScopeTag('round(Hs, 2) #@s12')).toBe('round(Hs, 2)');
  });

  it('cada \\py{} queda situado entre los eventos de su archivo', () => {
    const f = {
      events: [{ kind: 'notebook', at: 10, end: 1 }, { kind: 'notebook', at: 50, end: 2 }],
      pyExprs: [{ start: 5, end: 12, expr: 'a' }, { start: 30, end: 37, expr: 'b' }, { start: 80, end: 87, expr: 'c' }],
      pyIfs: [],
    };
    expect(occurrencesOf('d', f, 0).map((o) => [o.text, o.pos])).toEqual([['a', 0], ['b', 1], ['c', 2]]);
  });
});

describe('autocompletado dentro de \\py{…}', () => {
  it('sabe que el cursor está en un \\py{} y qué hay escrito', () => {
    expect(pyExprBefore('El valor \\py{')).toBe('');
    expect(pyExprBefore('El valor \\py{filas_ln(rumbo_')).toBe('filas_ln(rumbo_');
    expect(pyExprBefore('\\pyif{Hs')).toBe('Hs');
    expect(pyExprBefore('\\py{d[{"a": 1}["a"]] + x')).toBe('d[{"a": 1}["a"]] + x');
    expect(pyExprBefore('\\textbf{hola')).toBe(null);
    expect(pyExprBefore('\\py{x} y luego texto')).toBe(null);
    expect(pyExprBefore('\\py*{x')).toBe(null);
  });
});
