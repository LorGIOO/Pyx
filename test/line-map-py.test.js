// The build↔source line map must follow EVERYTHING that changes how many
// lines the build copy has: removed cells, multi-line \py{} values (tables,
// figures) and multi-line \pyif{}. Ctrl+click (both ways) and the log's error
// lines all read this map.

import { describe, it, expect } from 'vitest';
import {
  neutralizeCells, resolvePyText, resolvePyIf, resolvePyMapped, pyifKey, buildToSrcLine, srcToBuildLine,
} from '../js/compile/latex-bridge.js';

const ok = (value) => ({ ok: true, value });

/** Build the text and its map the way compiler.js does. */
function build(src, values) {
  const neut = neutralizeCells(src, {});
  const res = resolvePyMapped(neut.text, values, neut.srcLines);
  return { ...res, legacy: resolvePyText(resolvePyIf(neut.text, values), values) };
}
/** Source line (1-based) of the build line that contains `needle`. */
function srcLineOf(b, needle) {
  const i = b.text.split('\n').findIndex((l) => l.includes(needle));
  expect(i).toBeGreaterThanOrEqual(0);
  return buildToSrcLine(b.lines, i + 1);
}

describe('mapa de líneas con \\py{} y \\pyif{} de varias líneas', () => {
  it('el texto es idéntico al de resolvePyText(resolvePyIf())', () => {
    const src = 'a \\py{x} b\n\\pyif{c}{sí\nsí2}{no}\nfin \\py*{x}';
    const values = { x: ok('1\n2\n3'), [pyifKey('c')]: ok('True') };
    const b = build(src, values);
    expect(b.text).toBe(b.legacy);
  });

  it('sin cambios de líneas no hay mapa (la copia es línea a línea el fuente)', () => {
    const b = build('uno \\py{x}\ndos', { x: ok('7') });
    expect(b.lines).toBe(null);
    expect(b.text).toBe('uno 7\ndos');
  });

  it('una tabla de varias líneas no desplaza lo que hay debajo', () => {
    const src = [
      'Intro',                 // 1
      '\\py{tabla}',           // 2
      'Texto tras la tabla',   // 3
      '\\section{Weibull}',    // 4
    ].join('\n');
    const tabla = '\\begin{tabular}{ll}\na & b \\\\\nc & d \\\\\n\\end{tabular}';
    const b = build(src, { tabla: ok(tabla) });
    expect(b.text.split('\n').length).toBe(7);
    expect(srcLineOf(b, 'Intro')).toBe(1);
    expect(srcLineOf(b, 'c & d')).toBe(2);           // dentro de la tabla: la línea del \py
    expect(srcLineOf(b, 'Texto tras la tabla')).toBe(3);
    expect(srcLineOf(b, 'Weibull')).toBe(4);
    // Y al revés: la línea 4 del fuente es la 7 de la copia.
    expect(srcToBuildLine(b.lines, 4)).toBe(7);
    expect(srcToBuildLine(b.lines, 2)).toBe(2);
  });

  it('celdas quitadas + tabla + figura: cada línea vuelve a la suya', () => {
    const src = [
      '%#python',              // 1
      'x = 1',                 // 2
      '%#end',                 // 3
      'Antes',                 // 4
      '\\py{fig}',             // 5
      'Entre medias',          // 6
      '%#python',              // 7
      'y = 2',                 // 8
      '%#end',                 // 9
      'Valor \\py{t} final',   // 10
      'Última',                // 11
    ].join('\n');
    const b = build(src, { fig: ok('\\begin{figure}\n\\includegraphics{a}\n\\end{figure}'), t: ok('L1\nL2') });
    expect(srcLineOf(b, 'Antes')).toBe(4);
    expect(srcLineOf(b, 'includegraphics')).toBe(5);
    expect(srcLineOf(b, 'Entre medias')).toBe(6);
    expect(srcLineOf(b, 'Valor L1')).toBe(10);
    expect(srcLineOf(b, 'L2 final')).toBe(10);
    expect(srcLineOf(b, 'Última')).toBe(11);
    expect(b.text).toBe(b.legacy);
  });

  it('un \\pyif de varias líneas: la rama elegida conserva sus líneas y lo de después no se mueve', () => {
    const src = [
      'A',                         // 1
      '\\pyif{c}{',                // 2
      'rama sí 1',                 // 3
      'rama sí 2',                 // 4
      '}{',                        // 5
      'rama no',                   // 6
      '}',                         // 7
      'B',                         // 8
    ].join('\n');
    const yes = build(src, { [pyifKey('c')]: ok('True') });
    expect(srcLineOf(yes, 'rama sí 1')).toBe(3);
    expect(srcLineOf(yes, 'rama sí 2')).toBe(4);
    expect(srcLineOf(yes, 'B')).toBe(8);
    const no = build(src, { [pyifKey('c')]: ok('False') });
    expect(srcLineOf(no, 'rama no')).toBe(6);
    expect(srcLineOf(no, 'B')).toBe(8);
    expect(yes.text).toBe(yes.legacy);
    expect(no.text).toBe(no.legacy);
  });

  it('el mapa es monótono (la búsqueda directa lo recorre por bisección)', () => {
    const src = 'a\n\\py{t}\nb\n\\pyif{c}{x\ny\nz}{w}\nc\n\\py{t}\nd';
    const b = build(src, { t: ok('1\n2\n3\n4'), [pyifKey('c')]: ok('True') });
    for (let i = 1; i < b.lines.length; i++) expect(b.lines[i]).toBeGreaterThanOrEqual(b.lines[i - 1]);
    expect(b.lines.length).toBe(b.text.split('\n').length);
  });
});
