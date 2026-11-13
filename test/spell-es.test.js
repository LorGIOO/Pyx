// Spanish formations the dictionary does not list, and the grammar/style
// rules: what must be accepted, what must still be marked.
import { describe, it, expect } from 'vitest';
import { esFormation } from '../js/editor/spell-es.js';
import { grammarHits } from '../js/editor/grammar.js';

const DICT = new Set(['definir', 'pega', 'calculando', 'dar', 'calcular', 'calentado', 'ancho', 'gráfica', 'fácil',
  'requisito', 'grande', 'calcula', 'obtener', 'casa', 'perro']);
const known = (w) => DICT.has(w);
const ok = (w) => esFormation(w, known);

describe('formación de palabras en español', () => {
  it('verbos con pronombres pegados', () => {
    expect(ok('definirlo')).toBe(true);
    expect(ok('obtenerse')).toBe(true);
    expect(ok('dárselo')).toBe(true);
    expect(ok('calculándose')).toBe(true);
    expect(ok('pégalas')).toBe(true);
    expect(ok('calcúlalo')).toBe(true);
  });
  it('prefijos, -mente y superlativos sobre palabras conocidas', () => {
    expect(ok('recalcular')).toBe(true);
    expect(ok('precalentado')).toBe(true);
    expect(ok('prerrequisito')).toBe(true);
    expect(ok('gráficamente')).toBe(true);
    expect(ok('fácilmente')).toBe(true);
    expect(ok('grandísimo')).toBe(true);
  });
  it('una errata sigue siendo una errata', () => {
    expect(ok('definirrlo')).toBe(false);
    expect(ok('recalcluar')).toBe(false);
    expect(ok('casalo')).toBe(false);      // el imperativo lleva tilde: «cásalo»
    expect(ok('xyzmente')).toBe(false);
    expect(ok('perrolo')).toBe(false);
  });
});

describe('reglas de puntuación (azul) y de redacción (verde)', () => {
  const msgs = (t) => grammarHits(t, 'es').map((h) => `${h.kind || 'punt'}:${h.message}`);
  it('espacios y puntuación', () => {
    expect(msgs('Un  texto con dos espacios.').some((m) => m.startsWith('punt:Sobran espacios'))).toBe(true);
    expect(msgs('Entre ( paréntesis ) así.').length).toBe(2);
    expect(msgs('Una carga de 25kN en el nudo.').some((m) => m.includes('«25 kN»'))).toBe(true);
    expect(msgs('Termina aquí.Empieza otra.').some((m) => m.includes('Falta un espacio'))).toBe(true);
    expect(msgs('Hay vigas, pilares,, zapatas.').some((m) => m.includes('repetido'))).toBe(true);
  });
  it('no molesta donde no debe', () => {
    expect(msgs('Una carga de 25 kN y 3,5 m de luz.')).toEqual([]);
    expect(msgs('Se obtiene... después.')).toEqual([]);
    expect(msgs('El valor es 1.5 y el otro 2.')).toEqual([]);
  });
  it('redacción en verde', () => {
    expect(msgs('Se calcula en base a la norma.')[0]).toMatch(/^style:/);
    expect(msgs('Han habido cambios.')[0]).toMatch(/^style:.*ha habido/);
    expect(msgs('La la viga.')[0]).toMatch(/^style:Palabra repetida/);
  });
});
