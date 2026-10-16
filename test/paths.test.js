import { describe, it, expect } from 'vitest';
import { normalizePath, samePath, joinPath, relativeTo } from '../js/core/paths.js';

describe('normalizePath / samePath', () => {
  it('drops ./ so an \\input{./cap.pltx} chapter is the file the editor has open', () => {
    const child = joinPath(String.raw`E:\1. ULL\Tarea 2\1. Main`, './documento_1.pltx');
    expect(normalizePath(child)).toBe(String.raw`E:\1. ULL\Tarea 2\1. Main\documento_1.pltx`);
    expect(samePath(child, String.raw`e:\1. ull\tarea 2\1. main\DOCUMENTO_1.pltx`)).toBe(true);
  });

  it('resolves .. segments', () => {
    expect(normalizePath(String.raw`E:\p\1. Main\..\999. Recursos\x.pdf`)).toBe(String.raw`E:\p\999. Recursos\x.pdf`);
    expect(normalizePath('/home/u/doc/../shared/a.tex')).toBe('/home/u/shared/a.tex');
  });

  it('never climbs above a drive or the root', () => {
    expect(normalizePath(String.raw`C:\..\a`)).toBe(String.raw`C:\..\a`);
    expect(normalizePath('/../a')).toBe('/../a');
  });

  it('keeps UNC prefixes, collapses doubled separators', () => {
    expect(normalizePath(String.raw`\\server\share\.\a.tex`)).toBe(String.raw`\\server\share\a.tex`);
    expect(normalizePath(String.raw`C:\a\\b\c.tex`)).toBe(String.raw`C:\a\b\c.tex`);
  });

  it('compares across separator styles', () => {
    expect(samePath('C:/a/b.tex', String.raw`C:\a\b.tex`)).toBe(true);
    expect(samePath('C:/a/b.tex', String.raw`C:\a\c.tex`)).toBe(false);
    expect(samePath(null, 'x')).toBe(false);
  });

  it('a normalized child is relative to its project without ./', () => {
    const root = String.raw`E:\p\1. Main`;
    expect(relativeTo(root, normalizePath(joinPath(root, './cap/uno.pltx')))).toBe('cap/uno.pltx');
  });
});
