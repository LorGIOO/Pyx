import { describe, it, expect } from 'vitest';
import { latexEscapes, escapesProject } from '../js/collab/latex-guard.js';

const files = (content) => new Map([['/p/main.tex', { content }]]);

describe('collab · LaTeX que lee fuera del proyecto', () => {
  it('rutas que salen de la carpeta', () => {
    for (const p of ['/etc/passwd', 'C:/Users/a/x.txt', 'C:\\x', '..\\x', '../secret', 'a/../../b', '~/.ssh/id_rsa', '\\\\srv\\share', '|ls'])
      expect(escapesProject(p), p).toBe(true);
    for (const p of ['cap1', 'cap/intro.tex', 'xref/g.png', './fig.pdf', 'a..b.tex'])
      expect(escapesProject(p), p).toBe(false);
  });

  it('bloquea \\input, \\includegraphics, \\verbatiminput… con rutas de fuera', () => {
    for (const src of [
      '\\input{/etc/passwd}',
      '\\include{../../secreto}',
      '\\includegraphics[width=3cm]{C:/Users/ana/foto.png}',
      '\\verbatiminput{~/.bashrc}',
      '\\lstinputlisting[language=Python]{../../clave.py}',
      '\\graphicspath{{./img/}{/home/ana/}}',
      '\\IfFileExists{/etc/hosts}{\\input{/etc/hosts}}{}',
      '\\immediate\\openin5=/etc/passwd',
      '\\immediate\\write18{rm -rf ~}',
      '\\input|"ls"',
    ]) expect(latexEscapes(files(src)), src).not.toBe('');
  });

  // What no path check can follow: Lua opening files by itself, and file
  // commands whose name is assembled so the scan never sees them.
  it('bloquea Lua y las órdenes de lectura encubiertas', () => {
    for (const src of [
      '\\directlua{local f = io.open("/etc/passwd"); tex.print(f:read("a"))}',
      '\\latelua{os.execute("x")}',
      '\\begin{luacode*}\nio.open("C:/x")\n\\end{luacode*}',
      '\\csname @@input\\endcsname /etc/passwd',
      '\\expandafter\\csname input\\endcsname{/etc/passwd}',
      '\\csname openin\\endcsname5=/etc/passwd',
      '\\catcode`\\|=0 |input{/etc/passwd}',
      '\\catcode`\\!=0',
      '\\uppercase{\\input{/ETC/x}}',
    ]) expect(latexEscapes(files(src)), src).not.toBe('');
    // …without getting in the way of ordinary documents.
    for (const src of [
      '\\catcode`\\@=11 \\makeatletter',
      '\\csname mi@orden\\endcsname',
      '\\uppercase{título}',
      'Código de ejemplo: directlua no se usa aquí.',
      '\\catcode`\\_=12',
    ]) expect(latexEscapes(files(src)), src).toBe('');
  });

  it('deja pasar un proyecto normal y lo comentado', () => {
    const ok = [
      '\\documentclass{article}',
      '\\usepackage{graphicx}',
      '\\input{capitulos/intro}',
      '\\includegraphics[width=\\linewidth]{xref/fig.png}',
      '% \\input{/etc/passwd}  (comentado)',
      'El 50\\% de \\textbf{algo}.',
    ].join('\n');
    expect(latexEscapes(files(ok))).toBe('');
  });
});

import { checkLatex } from '../js/collab/latex-guard.js';

describe('collab · carpeta compartida («carpeta madre»)', () => {
  const tree = (main, more = {}) => new Map([
    ['/p/tesis/preambulo/main.tex', { content: main }],
    ...Object.entries(more).map(([k, v]) => [k, { content: v }]),
  ]);
  const opts = { shareRoot: '/p/tesis', cwd: '/p/tesis/preambulo' };

  it('capítulos, figuras y bibliografía en carpetas vecinas: se compila (sin modo paranoico)', () => {
    const r = checkLatex(tree([
      '\\input{../capitulos/cap1}',
      '\\includegraphics{../figuras/plano.pdf}',
      '\\bibliography{../biblio/refs}',
      '\\graphicspath{{../figuras/}}',
      '\\IfFileExists{../capitulos/anexo.tex}{\\input{../capitulos/anexo}}{}',
    ].join('\n'), { '/p/tesis/capitulos/cap1.tex': 'Texto \\input{../capitulos/cap2}' }), opts);
    expect(r.error).toBe('');
    expect(r.climbs).toBe(true);
  });

  it('un proyecto que no sale de su carpeta puede usar el modo paranoico', () => {
    const r = checkLatex(new Map([['/p/tesis/main.tex', { content: '\\input{caps/c1}\\includegraphics{xref/g.png}' }]]), { shareRoot: '/p/tesis', cwd: '/p/tesis' });
    expect(r).toEqual({ error: '', climbs: false });
  });

  it('lo que sale de la carpeta compartida sigue bloqueado', () => {
    for (const src of ['\\input{../../secreto}', '\\input{/etc/passwd}', '\\includegraphics{../../../home/ana/foto.png}', '\\input{~/.bashrc}']) {
      expect(checkLatex(tree(src), opts).error, src).not.toBe('');
    }
  });

  it('rutas absolutas dentro de la carpeta compartida valen', () => {
    expect(checkLatex(tree('\\input{/p/tesis/capitulos/cap1}'), opts).error).toBe('');
  });

  it('nombres de archivo hechos con macros se rechazan (salvo \\py{})', () => {
    expect(checkLatex(tree('\\def\\a{/etc/passwd}\\input{\\a}'), opts).error).not.toBe('');
    expect(checkLatex(tree('\\input \\a'), opts).error).not.toBe('');
    expect(checkLatex(tree('\\input /etc/passwd'), opts).error).not.toBe('');
    expect(checkLatex(tree('\\makeatletter\\@@input /etc/passwd'), opts).error).not.toBe('');
    expect(checkLatex(tree('\\includegraphics{\\py{p}}'), opts).error).toBe('');
    expect(checkLatex(tree('\\usepackage{amsmath}\\documentclass[12pt]{article}'), opts).error).toBe('');
  });
});

describe('collab · rutas relativas explícitas', () => {
  it('«../» se resuelve desde la carpeta de trabajo, no desde cada carpeta de búsqueda', () => {
    const files = new Map([
      ['/p/tesis/preambulo/main.tex', { content: '\\input{../capitulos/cap1}' }],
      ['/p/tesis/intro.tex', { content: 'Introducción' }],
    ]);
    expect(checkLatex(files, { shareRoot: '/p/tesis', cwd: '/p/tesis/preambulo' }).error).toBe('');
  });
});
