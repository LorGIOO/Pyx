import { describe, it, expect } from 'vitest';
import { searchTexts, replaceInText, queryRegExp } from '../js/editor/project-search.js';

const files = [
  { path: 'main.tex', text: '\\section{Vigas}\nLa viga mide L.\n\\input{cap1}' },
  { path: 'cap1.tex', text: 'Una VIGA continua.\nvigas y viguetas' },
];

describe('project search', () => {
  it('finds every match with line, column and the line text', () => {
    const r = searchTexts(files, 'viga');
    expect(r.total).toBe(4);
    expect(r.files[0].matches[0]).toMatchObject({ line: 1, col: 9, len: 4 });
    expect(r.files[1].matches.map((m) => m.line)).toEqual([1, 2]);
  });

  it('honours case, whole word and regular expressions', () => {
    expect(searchTexts(files, 'viga', { caseSensitive: true }).total).toBe(2);
    expect(searchTexts(files, 'viga', { whole: true }).total).toBe(2);
    expect(searchTexts(files, 'vig(a|ueta)s', { regexp: true }).total).toBe(3);
    expect(queryRegExp('(', { regexp: true })).toBeNull();
  });

  it('replaces, with $1 for groups in regular expressions', () => {
    expect(replaceInText('viga y vigas', 'viga', 'losa', { whole: true })).toEqual({ text: 'losa y vigas', count: 1 });
    expect(replaceInText('L=5 m', '(\\d+) m', '$1 metros', { regexp: true }).text).toBe('L=5 metros');
  });

  it('caps the number of results', () => {
    const big = [{ path: 'x', text: 'a '.repeat(100) }];
    const r = searchTexts(big, 'a', {}, 10);
    expect(r.total).toBe(10);
    expect(r.capped).toBe(true);
  });
});
