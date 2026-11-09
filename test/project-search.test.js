import { describe, it, expect } from 'vitest';
import {
  searchTexts, replaceInText, replaceEdits, replaceInBytes, queryRegExp,
} from '../js/editor/project-search.js';

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

  // F7c · the list and «Reemplazar todo» must mean the same matches. The
  // replace used to run the expression over the whole text while the list
  // searched line by line.
  it('replaces exactly the matches the search lists, for expressions that could cross lines', () => {
    const text = 'a  \nb\n\n  x = 1\n\\item{uno\ndos}\nfin  \r\n^raro$\r\n';
    const cases = [
      ['\\s+', '_'],       // whitespace must not swallow the line breaks
      ['^\\s*', '>'],      // start of EVERY line; empty matches are not matches
      ['\\s*$', ''],       // trailing blanks of every line
      ['\\{[^}]*\\}?', ''], // a negated class must stop at the end of the line
      ['^', '>'],          // only empty matches: nothing to do
      ['.+', 'X'],
    ];
    for (const [q, rep] of cases) {
      const found = searchTexts([{ path: 'f', text }], q, { regexp: true });
      const edits = replaceEdits(text, q, rep, { regexp: true });
      const done = replaceInText(text, q, rep, { regexp: true });
      expect(edits.length, q).toBe(found.total);
      expect(done.count, q).toBe(found.total);
      // Same places: each edit is one listed match, by line and column.
      const lineStarts = [0];
      for (const m of text.matchAll(/\r?\n/g)) lineStarts.push(m.index + m[0].length);
      const listed = found.files.flatMap((f) => f.matches).map((m) => [lineStarts[m.line - 1] + m.col, m.len]);
      expect(edits.map((e) => [e.from, e.to - e.from]), q).toEqual(listed);
      // Line breaks are never part of a match, so their number never changes.
      expect(done.text.split(/\r?\n/).length, q).toBe(text.split(/\r?\n/).length);
    }
    expect(replaceInText('a  \nb', '\\s+', '_', { regexp: true }).text).toBe('a_\nb');
    expect(replaceInText('x\ny', '^', '>', { regexp: true })).toEqual({ text: 'x\ny', count: 0 });
    expect(replaceInText('uno\ndos', '^(\\w)', '[$1]$&', { regexp: true }).text).toBe('[u]uno\n[d]dos');
  });

  // F7b · a closed file is changed on its own bytes and written back in its
  // own encoding. It used to be read as lossy UTF-8 and saved as UTF-8.
  it('replaces in a Windows-1252 file without re-encoding or damaging it', () => {
    // "sección de la viga\r\nañadir viga €\r\n" in Windows-1252.
    const src = Uint8Array.from([
      ...[...'secci'].map((c) => c.charCodeAt(0)), 0xF3, ...[...'n de la viga\r\na'].map((c) => c.charCodeAt(0)),
      0xF1, ...[...'adir viga '].map((c) => c.charCodeAt(0)), 0x80, 0x0D, 0x0A,
    ]);
    const out = replaceInBytes(src, 'viga', 'losa', {});
    expect(out.count).toBe(2);
    expect(out.unmappable).toEqual([]);
    expect(out.bytes.length).toBe(src.length); // still one byte per character
    expect(new TextDecoder('windows-1252').decode(out.bytes)).toBe('sección de la losa\r\nañadir losa €\r\n');
    // Searching with an accent works, and the accent is written as ONE byte.
    const acc = replaceInBytes(src, 'sección', 'Sección', { caseSensitive: true });
    expect(acc.count).toBe(1);
    expect(acc.bytes[0]).toBe(0x53);
    expect(acc.bytes[5]).toBe(0xF3);
    // A replacement the file's encoding cannot hold is reported, not written as "?".
    const bad = replaceInBytes(src, 'viga', 'β', {});
    expect(bad.unmappable).toEqual(['β']);
    // No match: the very same bytes, nothing to write.
    expect(replaceInBytes(src, 'no está', 'x', {})).toMatchObject({ count: 0, bytes: src });
  });

  it('keeps a UTF-8 file UTF-8, with its BOM and its mixed line breaks', () => {
    const src = Uint8Array.from([0xEF, 0xBB, 0xBF, ...new TextEncoder().encode('año\r\nviga\nfin')]);
    const out = replaceInBytes(src, 'viga', 'β-losa', {});
    expect([...out.bytes.slice(0, 3)]).toEqual([0xEF, 0xBB, 0xBF]);
    expect(new TextDecoder('utf-8', { ignoreBOM: true }).decode(out.bytes.slice(3))).toBe('año\r\nβ-losa\nfin');
    // Pure ASCII has no encoding of its own: it takes the new character as UTF-8.
    const ascii = replaceInBytes(new TextEncoder().encode('viga'), 'viga', 'año', {});
    expect(new TextDecoder().decode(ascii.bytes)).toBe('año');
  });

  it('caps the number of results', () => {
    const big = [{ path: 'x', text: 'a '.repeat(100) }];
    const r = searchTexts(big, 'a', {}, 10);
    expect(r.total).toBe(10);
    expect(r.capped).toBe(true);
  });
});
