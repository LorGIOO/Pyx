// F12 · only text opens in the editor. A .zip or a video opened as text is
// megabytes of mojibake that one Ctrl+S writes back over the file.

import { describe, it, expect } from 'vitest';
import {
  extOf, isTextName, looksBinary, openTarget, MAX_TEXT_BYTES, MAX_SNIFF_BYTES,
} from '../js/core/file-kind.js';

describe('which files the file tree opens in the editor', () => {
  it('reads the extension like a file manager does', () => {
    expect(extOf('informe.TEX')).toBe('tex');
    expect(extOf('C:\\p\\cap.1\\notas.final.md')).toBe('md');
    expect(extOf('Makefile')).toBe('');
    expect(extOf('.gitignore')).toBe(''); // a dot-file has no extension
    expect(extOf('carpeta.con.puntos/archivo')).toBe('');
  });

  it('knows the text files of a LaTeX project', () => {
    for (const n of ['a.tex', 'b.pltx', 'c.sty', 'd.cls', 'e.bib', 'f.py', 'g.md', 'h.csv', 'i.log', 'j.ipynb', 'k.JSON']) {
      expect(isTextName(n), n).toBe(true);
    }
    for (const n of ['a.zip', 'b.mp4', 'c.xlsx', 'd.exe', 'e.docx', 'f.7z', 'g.dll', 'sin-extension']) {
      expect(isTextName(n), n).toBe(false);
    }
  });

  it('decides where a file opens from its name and size', () => {
    expect(openTarget('capitulo.tex', 12_000)).toBe('text');
    expect(openTarget('capitulo.tex', -1)).toBe('text'); // size unknown
    // Known text, but too big for the editor.
    expect(openTarget('simulacion.log', MAX_TEXT_BYTES + 1)).toBe('external');
    // A .pltx container is as big as its figures; its text is not.
    expect(openTarget('informe.pltx', 80 * 1024 * 1024)).toBe('text');
    // Unknown type: looked at only when small.
    expect(openTarget('datos.zip', 5_000)).toBe('sniff');
    expect(openTarget('Makefile', 800)).toBe('sniff');
    expect(openTarget('video.mp4', MAX_SNIFF_BYTES + 1)).toBe('external');
  });

  it('tells binary bytes from text', () => {
    const zip = Uint8Array.from([0x50, 0x4B, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00]);
    const png = Uint8Array.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D]);
    expect(looksBinary(zip)).toBe(true);
    expect(looksBinary(png)).toBe(true);
    expect(looksBinary(new TextEncoder().encode('all: informe.pdf\n\tlatexmk año\n'))).toBe(false);
    expect(looksBinary(Uint8Array.from([0x61, 0xF1, 0x6F]))).toBe(false); // Latin-1 text
    expect(looksBinary(new Uint8Array(0))).toBe(false);
    // UTF-16 text is full of NULs, and is still text (the editor reads it).
    expect(looksBinary(Uint8Array.from([0xFF, 0xFE, 0x61, 0x00, 0x62, 0x00]))).toBe(false);
  });
});
