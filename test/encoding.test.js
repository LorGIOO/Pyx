// How a file is stored on disk must survive a round trip through the editor:
// its encoding, its BOM and its line endings (F6).

import { describe, it, expect } from 'vitest';
import {
  decodeBytes, encodeText, detectEol, formatFromSetting, encodingLabel,
} from '../js/core/encoding.js';

const bytesOf = (...b) => new Uint8Array(b);
const same = (d) => ({ encoding: d.encoding, bom: d.bom, eol: d.eol });

describe('decodeBytes / encodeText', () => {
  it('Windows-1252: every one of the 256 bytes round-trips', () => {
    const all = new Uint8Array(256 + 2);
    for (let i = 0; i < 256; i++) all[i] = i;
    // 0x0D alone and 0x0A alone are line breaks; end on a real CRLF so the
    // file's line ending is unambiguous and the bytes come back untouched.
    all[256] = 0x0D; all[257] = 0x0A;
    // Not valid UTF-8 (0x80 alone), so it is read as Windows-1252.
    const d = decodeBytes(all);
    expect(d.encoding).toBe('windows-1252');
    expect(d.bom).toBe(false);
    // The same table the platform's decoder uses.
    expect(d.text).toBe(new TextDecoder('windows-1252').decode(all));
    const back = encodeText(d.text, { encoding: 'windows-1252', bom: false, eol: null });
    expect(back.unmappable).toEqual([]);
    expect([...back.bytes]).toEqual([...all]);
  });

  it('Windows-1252 is a real table: € “ ” — are single bytes, not "?"', () => {
    const { bytes, unmappable } = encodeText('€ “a” – —', { encoding: 'windows-1252' });
    expect(unmappable).toEqual([]);
    expect([...bytes]).toEqual([0x80, 0x20, 0x93, 0x61, 0x94, 0x20, 0x96, 0x20, 0x97]);
  });

  it('reports what an encoding cannot hold instead of writing "?" silently', () => {
    const cp = encodeText('α → ñ 😀 α', { encoding: 'windows-1252' });
    expect(cp.unmappable).toEqual(['α', '→', '😀']); // distinct, in order; ñ fits
    const latin = encodeText('ñ € “', { encoding: 'iso-8859-1' });
    expect(latin.unmappable).toEqual(['€', '“']); // Latin-1 has no 0x80–0x9F
    const ascii = encodeText('año', { encoding: 'us-ascii' });
    expect(ascii.unmappable).toEqual(['ñ']);
    expect(encodeText('año α 😀', { encoding: 'utf-8' }).unmappable).toEqual([]);
  });

  it('UTF-8: a BOM is detected, dropped from the text and written back', () => {
    const withBom = bytesOf(0xEF, 0xBB, 0xBF, 0x61, 0xC3, 0xB1);
    const d = decodeBytes(withBom);
    expect(d).toMatchObject({ text: 'añ', encoding: 'utf-8', bom: true, ascii: false });
    expect([...encodeText(d.text, same(d)).bytes]).toEqual([...withBom]);
    const plain = decodeBytes(bytesOf(0x61, 0xC3, 0xB1));
    expect(plain).toMatchObject({ text: 'añ', encoding: 'utf-8', bom: false, ascii: false });
    expect([...encodeText(plain.text, same(plain)).bytes]).toEqual([0x61, 0xC3, 0xB1]);
  });

  it('pure ASCII says so: its bytes cannot tell the encoding', () => {
    expect(decodeBytes(new TextEncoder().encode('\\section{Vigas}\n')).ascii).toBe(true);
    expect(decodeBytes(new TextEncoder().encode('año')).ascii).toBe(false);
    expect(decodeBytes(new Uint8Array(0))).toMatchObject({ text: '', ascii: true, eol: '\n' });
  });

  it('CRLF survives: detected on open, written back on save', () => {
    const src = new TextEncoder().encode('uno\r\ndos\r\ntres\r\n');
    const d = decodeBytes(src);
    expect(d.eol).toBe('\r\n');
    // The editor (CodeMirror) hands the text back with LF only.
    const fromEditor = d.text.replace(/\r\n/g, '\n');
    expect([...encodeText(fromEditor, same(d)).bytes]).toEqual([...src]);
    // …and an LF file stays LF.
    const lf = decodeBytes(new TextEncoder().encode('uno\ndos\n'));
    expect(lf.eol).toBe('\n');
    expect(new TextDecoder().decode(encodeText('uno\ndos\n', same(lf)).bytes)).toBe('uno\ndos\n');
  });

  it('detectEol takes the most frequent line ending', () => {
    expect(detectEol('')).toBe('\n');
    expect(detectEol('sin saltos')).toBe('\n');
    expect(detectEol('a\r\nb\r\nc\n')).toBe('\r\n');
    expect(detectEol('a\nb\nc\r\n')).toBe('\n');
    expect(detectEol('a\rb\rc')).toBe('\r');
  });

  it('eol: null leaves the text\'s own line breaks alone (mixed files)', () => {
    const out = encodeText('a\r\nb\nc', { encoding: 'utf-8', eol: null });
    expect(new TextDecoder().decode(out.bytes)).toBe('a\r\nb\nc');
  });

  it('UTF-16 with a BOM is read and written back, not shown as garbage', () => {
    const le = bytesOf(0xFF, 0xFE, 0x61, 0x00, 0xF1, 0x00, 0x0A, 0x00);
    const d = decodeBytes(le);
    expect(d).toMatchObject({ text: 'añ\n', encoding: 'utf-16le', bom: true });
    expect([...encodeText(d.text, same(d)).bytes]).toEqual([...le]);
    const be = bytesOf(0xFE, 0xFF, 0x00, 0x61, 0x00, 0xF1);
    const b = decodeBytes(be);
    expect(b).toMatchObject({ text: 'añ', encoding: 'utf-16be' });
    expect([...encodeText(b.text, same(b)).bytes]).toEqual([...be]);
  });

  it('maps the options of Configuración', () => {
    expect(formatFromSetting('UTF-8')).toEqual({ encoding: 'utf-8', bom: false, eol: '\n' });
    expect(formatFromSetting('UTF-8 con BOM')).toMatchObject({ encoding: 'utf-8', bom: true });
    expect(formatFromSetting('ISO-8859-1 (Latin-1)').encoding).toBe('iso-8859-1');
    expect(formatFromSetting('Windows-1252').encoding).toBe('windows-1252');
    expect(formatFromSetting('US-ASCII').encoding).toBe('us-ascii');
    expect(formatFromSetting(undefined).encoding).toBe('utf-8');
    expect(encodingLabel('windows-1252')).toBe('Windows-1252');
  });
});
