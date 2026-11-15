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
