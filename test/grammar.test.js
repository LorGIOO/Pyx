import { describe, it, expect } from 'vitest';
import { grammarHits, ltDiagnostics } from '../js/editor/grammar.js';

const msgs = (s, lang) => grammarHits(s, lang).map((h) => [s.slice(h.from, h.to), h.message]);

describe('local grammar rules', () => {
  it('repeated words', () => {
    expect(msgs('La viga viga es larga.')[0][0]).toBe('viga');
  });
  it('spaces around punctuation', () => {
    expect(msgs('Hola , mundo.')[0][1]).toMatch(/Sobra el espacio/);
    expect(msgs('uno,dos')[0][1]).toMatch(/Falta un espacio/);
    expect(msgs('vale 1,5 kN')).toEqual([]);
  });
  it('capital after a full stop, not after an abbreviation or a number', () => {
    expect(msgs('Fin. empieza otra.')[0][1]).toMatch(/mayúscula/);
    expect(msgs('Ver p. ej. la tabla.')).toEqual([]);
    expect(msgs('Ver fig. 2 y etc. otra')).toEqual([]);
  });
  it('Spanish: contractions and opening ¿ ¡', () => {
    expect(msgs('Vamos a el puerto.', 'es')[0]).toEqual(['a el', 'Se escribe «al»']);
    expect(msgs('Es de él.', 'es')).toEqual([]);
    expect(msgs('Qué carga resiste?', 'es')[0][1]).toMatch(/apertura «¿»/);
    expect(msgs('¿Qué carga resiste?', 'es')).toEqual([]);
    expect(msgs('What load?', 'en')).toEqual([]);
  });
});

describe('LanguageTool matches → diagnostics', () => {
  it('maps offsets and replacements', () => {
    const d = ltDiagnostics([{ offset: 4, length: 3, message: 'Concordancia', rule: { id: 'X' }, replacements: [{ value: 'las' }] }], 100);
    expect(d[0]).toMatchObject({ from: 104, to: 107, severity: 'info', source: 'LanguageTool' });
    expect(d[0].actions[0].name).toBe('«las»');
  });
});
