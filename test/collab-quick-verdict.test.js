// The fast path of the host's permission check may only say "allowed"
// SOONER — never let through what the exact check refuses. Fuzzed here with
// thousands of random edits on a document full of traps.
import { describe, it, expect } from 'vitest';
import { Text } from '@codemirror/state';
import { quickVerdict, allowedChange, classifyChange } from '../js/collab/permissions.js';
import { parseCells } from '../js/editor/cell-parse.js';

const DOC = [
  '\\documentclass{article}',
  '\\begin{document}',
  'Texto normal con \\py{x} y \\pyif{x > 1}{grande}{pequeño}.',
  '%#python id=a1',
  'x = 2',
  'y = x * 3',
  '%#end',
  '% comentario con \\py{y}',
  'Una expresión larga \\py{f"{x:.2f}',
  '  y más"} sigue.',
  '\\begin{verbatim}',
  '%#python',
  'no es celda',
  '%#end',
  '\\end{verbatim}',
  'Con \\verb|\\py{z}| dentro.',
  'Un párrafo largo de prosa sin nada especial que se puede editar libremente.',
  'Otro párrafo %#python que no empieza línea.',
  '\\pyfile{datos.py}',
  '\\end{document}',
  '',
].join('\n');

const cellsOf = (text) => parseCells({ doc: text });
const LATEX = { python: false, latex: true };
const PY = { python: true, latex: false };

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
}
const CHARS = 'abc xyz=+*()0123456789\\{}%#\n|"';

function randomEdit(r, len) {
  const from = Math.floor(r() * (len + 1));
  const del = r() < 0.4 ? Math.min(len - from, Math.floor(r() * 6)) : 0;
  let ins = '';
  const n = r() < 0.3 ? 0 : 1 + Math.floor(r() * 4);
  // Mostly harmless letters (the common case), sometimes anything.
  const pool = r() < 0.7 ? 'abcdefg hij' : CHARS;
  for (let i = 0; i < n; i++) ins += pool[Math.floor(r() * pool.length)];
  if (!del && !ins) ins = 'q';
  return { from, del, ins };
}

function check(perms, seed, rounds) {
  const r = rng(seed);
  let quickYes = 0;
  for (let i = 0; i < rounds; i++) {
    const { from, del, ins } = randomEdit(r, DOC.length);
    const afterStr = DOC.slice(0, from) + ins + DOC.slice(from + del);
    const delta = [];
    if (from) delta.push({ retain: from });
    if (del) delta.push({ delete: del });
    if (ins) delta.push({ insert: ins });
    const q = quickVerdict(Text.of(DOC.split('\n')), Text.of(afterStr.split('\n')), delta, 'm.pltx', perms, cellsOf);
    if (q === true) {
      quickYes++;
      const exact = allowedChange(DOC, afterStr, 'm.pltx', perms);
      if (!exact.ok) {
        throw new Error(`fast path let through a refused edit: ${JSON.stringify({ from, del, ins, ctx: DOC.slice(Math.max(0, from - 20), from + 20), cls: classifyChange(DOC, afterStr, 'm.pltx') })}`);
      }
    }
  }
  return quickYes;
}

describe('collab · vía rápida de permisos', () => {
  it('solo LaTeX: nunca deja pasar lo que la comprobación exacta rechaza', () => {
    const yes = check(LATEX, 1, 6000);
    expect(yes).toBeGreaterThan(1000); // and it does decide the ordinary cases
  });

  it('solo Python: nunca deja pasar lo que la comprobación exacta rechaza', () => {
    const yes = check(PY, 2, 6000);
    expect(yes).toBeGreaterThan(50);
  });

  it('decide al instante la prosa en un documento enorme', () => {
    const big = Array.from({ length: 40000 }, (_, i) => (i % 40 === 0 ? `%#python\ny${i} = ${i}\n%#end` : `Párrafo ${i} con texto normal de relleno para ocupar espacio.`)).join('\n');
    const before = Text.of(big.split('\n'));
    const at = big.indexOf('Párrafo 20001') + 8;
    const after = before.replace(at, at, Text.of(['x']));
    cellsOf(before); cellsOf(after); // the editor has parsed both already
    const t0 = performance.now();
    const q = quickVerdict(before, after, [{ retain: at }, { insert: 'x' }], 'm.pltx', LATEX, cellsOf);
    const ms = performance.now() - t0;
    expect(q).toBe(true);
    expect(ms).toBeLessThan(15);
  });
});
