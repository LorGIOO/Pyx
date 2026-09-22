// The proofing dictionaries are a shipped asset, and a bad one is worse than
// none: if a calculation report comes out with half a page underlined, the
// checker stops being read at all. These tests pin down both directions —
// real words must be accepted, wrong ones must still be rejected — over the
// exact files the app loads at runtime.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Nspell from 'nspell';

const DICT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'dict');

/** Build a speller exactly the way js/editor/spellcheck.js does. */
function speller(code) {
  const s = Nspell(
    readFileSync(join(DICT, `${code}.aff`), 'utf8'),
    readFileSync(join(DICT, `${code}.dic`), 'utf8'),
  );
  const extraPath = join(DICT, `${code}.extra.txt`);
  if (existsSync(extraPath)) {
    for (const line of readFileSync(extraPath, 'utf8').split(/\r?\n/)) {
      const w = line.trim();
      if (w && !w.startsWith('#')) s.add(w);
    }
  }
  return s;
}

const es = speller('es');
const en = speller('en');

describe('diccionario · español', () => {
  it('acepta prosa corriente', () => {
    for (const w of ['mediante', 'según', 'través', 'asimismo', 'obtuvimos',
      'realizaríamos', 'comprobándose', 'contribuiríamos']) {
      expect(es.correct(w), w).toBe(true);
    }
  });

  it('acepta el vocabulario de ingeniería que ningún diccionario general trae', () => {
    for (const w of ['flector', 'axil', 'isostático', 'hiperestático', 'ferralla',
      'hormigonado', 'tablestaca', 'arriostramiento', 'geotecnia', 'edafología',
      'litología', 'hidrograma', 'taquimetría', 'sismorresistente', 'mayoración',
      'minoración', 'fisuración', 'baricentro', 'discretización', 'Eurocódigo']) {
      expect(es.correct(w), w).toBe(true);
    }
  });

  it('acepta esas palabras también a principio de frase', () => {
    for (const w of ['Flector', 'Hiperestático', 'Geotecnia', 'Mayoración']) {
      expect(es.correct(w), w).toBe(true);
    }
  });

  it('sigue rechazando erratas, incluidas las parecidas a lo que añadimos', () => {
    for (const w of ['ormigón', 'coheficiente', 'cimentasion', 'estructual',
      'flecktor', 'hiperstatico', 'arriostramento', 'ferraya', 'hidrogramma',
      'mayoracion', 'discretizacion', 'eurocodigo']) {
      expect(es.correct(w), w).toBe(false);
    }
  });

  it('sugiere la forma correcta de una palabra del suplemento', () => {
    expect(es.suggest('flecktor')).toContain('flector');
  });
});

describe('diccionario · inglés', () => {
  it('acepta la ortografía estadounidense Y la británica', () => {
    // public/dict/en.dic is the union of the US and GB word lists: a document
    // in British English used to come out fully underlined.
    for (const w of ['color', 'colour', 'center', 'centre', 'analyzed', 'analysed',
      'modeling', 'modelling', 'optimization', 'optimisation', 'behavior', 'behaviour']) {
      expect(en.correct(w), w).toBe(true);
    }
  });

  it('acepta el vocabulario técnico', () => {
    for (const w of ['rebar', 'formwork', 'centroid', 'geotechnical', 'granulometry',
      'hydrograph', 'subgrade', 'prestressed', 'shotcrete', 'cofferdam',
      'eigenvalue', 'isoparametric', 'Eurocode']) {
      expect(en.correct(w), w).toBe(true);
    }
  });

  it('sigue rechazando erratas', () => {
    for (const w of ['concreet', 'reinforcment', 'deflction', 'strucural',
      'rebarr', 'formwok', 'centroyd', 'subgrad', 'theodolyte']) {
      expect(en.correct(w), w).toBe(false);
    }
  });
});

describe('diccionario · integridad de los archivos', () => {
  it('cada .dic declara el número de entradas que realmente tiene', () => {
    for (const code of ['es', 'en']) {
      const lines = readFileSync(join(DICT, `${code}.dic`), 'utf8').split('\n');
      const declared = Number(lines[0].trim());
      const actual = lines.slice(1).filter((l) => l.trim()).length;
      expect(declared, code).toBe(actual);
    }
  });

  it('los suplementos no tienen duplicados ni espacios sueltos', () => {
    for (const code of ['es', 'en']) {
      const words = readFileSync(join(DICT, `${code}.extra.txt`), 'utf8')
        .split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
      expect(words.length, code).toBeGreaterThan(100);
      expect(new Set(words).size, `${code}: hay duplicados`).toBe(words.length);
      expect(words.every((w) => !/\s/.test(w)), `${code}: alguna línea tiene espacios`).toBe(true);
    }
  });
});
