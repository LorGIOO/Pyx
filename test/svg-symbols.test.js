// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { svgToTikz, normalizePath, commandFromName, svgDefinition } from '../js/data/svg-symbols.js';

const HEART = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#e11" d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>`;
const SHAPES = `<svg viewBox="0 0 20 20"><g transform="translate(2,2)"><rect x="0" y="0" width="6" height="6"/><circle cx="12" cy="3" r="3"/></g><line x1="0" y1="18" x2="20" y2="18" stroke="black" stroke-width="2"/><polygon points="2,10 8,10 5,15"/><path d="M0 0" fill="none"/></svg>`;

describe('symbols from SVG', () => {
  it('spells every number plainly for svg.path', () => {
    expect(normalizePath('M1.5-2l.5.5 1e1,2z')).toBe('M 1.5 -2 l 0.5 0.5 10 2 z');
    expect(normalizePath('a1 1 0 01 2 2')).toBe('a 1 1 0 0 1 2 2');
  });
  it('turns paths and shapes into TikZ with the viewBox', () => {
    const { tikz, w, h } = svgToTikz(HEART);
    expect(w).toBe(24); expect(h).toBe(24);
    expect(tikz).toMatch(/^\\tikz\[yscale=-1\]\{\\path\(0pt,0pt\)rectangle\(24pt,24pt\);\\fill\[\] svg\{M 12 21\.35 l/);
    const s = svgToTikz(SHAPES).tikz;
    expect(s).toContain('shift={(2pt,2pt)}');
    expect(s).toMatch(/\\draw\[line width=2pt\] svg\{M 0 18 L 20 18\}/);
    expect(s).toMatch(/svg\{M 2 10 L 8 10 L 5 15 Z\}/);
  });
  it('refuses what is not an SVG drawing', () => {
    expect(() => svgToTikz('<html></html>')).toThrow();
    expect(() => svgToTikz('<svg viewBox="0 0 1 1"></svg>')).toThrow();
  });
  it('names the command after the file', () => {
    expect(commandFromName('C:\\icons\\flecha-curva.svg')).toBe('\\flechaCurva');
    expect(commandFromName('/x/Árbol 2.svg')).toBe('\\arbol');
  });
  it('writes a document that compiles (scratch, for a manual check)', () => {
    const out = process.env.PYX_SVG_TEX;
    if (!out) return;
    const defs = [svgDefinition('\\corazon', svgToTikz(HEART).tikz), svgDefinition('\\formas', svgToTikz(SHAPES).tikz)].join('\n');
    writeFileSync(out, `\\documentclass{article}\\usepackage{graphicx,tikz,xcolor}\\usetikzlibrary{svg.path}\n${defs}\n\\begin{document}\nTexto \\corazon{} y \\formas, {\\color{red}\\Large grande \\corazon} y $x\\corazon$.\n\\end{document}\n`);
  });
});
