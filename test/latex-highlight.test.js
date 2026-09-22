// The LaTeX palette must match TeXstudio's factory scheme. The reference is
// TeXstudio's own two shipped format files (utilities/qxs/defaultFormats.qxf
// and defaultFormatsDark.qxf) plus the construct→format mapping in its source;
// the dark values were additionally cross-checked against the [formatsDark]
// block a real TeXstudio install writes into texstudio.ini.
//
// The three facts these tests are really guarding:
//   * `numbers` is the MATH BODY format — digits in text are NOT colored;
//   * braces, brackets and `\%` escapes have no color of their own;
//   * `\begin`/`\end` and `\section` share one format, the environment name
//     and the section title each get their own on top.

import { describe, it, expect } from 'vitest';
import { classifyLatex } from '../js/editor/latex-highlight.js';

function clsOf(src, token, nth = 0) {
  const hits = classifyLatex(src).filter((m) => src.slice(m.from, m.to) === token);
  return hits[nth] ? hits[nth].cls : null;
}
const classes = (src) => new Set(classifyLatex(src).map((m) => m.cls));

describe('LaTeX highlighting · commands', () => {
  it('a plain command is the keyword format', () => {
    expect(clsOf('\\textbf{hola}\n', '\\textbf')).toBe('cm-lx-cmd');
    expect(clsOf('\\maketitle\n', '\\maketitle')).toBe('cm-lx-cmd');
  });

  it('escaped characters use the SAME color as commands (TeXstudio has no escape format for LaTeX)', () => {
    const src = 'cien \\% y \\& y \\_ y \\\\ fin\n';
    expect(clsOf(src, '\\%')).toBe('cm-lx-cmd');
    expect(clsOf(src, '\\&')).toBe('cm-lx-cmd');
    expect(clsOf(src, '\\\\')).toBe('cm-lx-cmd');
  });

  it('\\begin/\\end are extra-keyword and the environment name gets its own color', () => {
    const src = '\\begin{itemize}\n\\end{itemize}\n';
    expect(clsOf(src, '\\begin{')).toBe('cm-lx-envkw');
    expect(clsOf(src, 'itemize', 0)).toBe('cm-lx-envname');
    expect(clsOf(src, '\\end{')).toBe('cm-lx-envkw');
  });

  it('a sectioning command is extra-keyword and its TITLE is the structure format', () => {
    const src = '\\section{Introducción}\n\\subsection*{Otra}\n';
    expect(clsOf(src, '\\section')).toBe('cm-lx-section');
    expect(clsOf(src, 'Introducción')).toBe('cm-lx-structure');
    expect(clsOf(src, '\\subsection*')).toBe('cm-lx-section');
    expect(clsOf(src, 'Otra')).toBe('cm-lx-structure');
  });

  it('\\ref, \\cite and \\usepackage color their ARGUMENT, \\label does not', () => {
    const src = '\\label{a:b} \\ref{a:b} \\cite{knuth} \\usepackage{amsmath}\n';
    expect(clsOf(src, 'a:b', 0)).toBe('cm-lx-ref');   // only \ref's argument
    expect(clsOf(src, 'knuth')).toBe('cm-lx-cite');
    expect(clsOf(src, 'amsmath')).toBe('cm-lx-package');
    // TeXstudio deliberately puts no overlay on \label's argument.
    const labelArg = classifyLatex(src).filter((m) => m.from < src.indexOf('\\ref'));
    expect(labelArg.every((m) => m.cls !== 'cm-lx-ref')).toBe(true);
  });
});

describe('LaTeX highlighting · what TeXstudio does NOT color', () => {
  it('braces and brackets get no color of their own', () => {
    const cls = classes('\\textbf{hola} [opcion] {suelto}\n');
    expect(cls.has('cm-lx-brace')).toBe(false);
    expect(cls.has('cm-lx-opt')).toBe(false);
  });

  it('digits in ordinary text get no color — `numbers` is the math format', () => {
    const src = 'El resultado es 42 y mide 10pt de ancho.\n';
    expect(classifyLatex(src)).toEqual([]);
  });

  it('math has a foreground, never a background tint', () => {
    const marks = classifyLatex('$x+1$\n');
    expect(marks.length).toBeGreaterThan(0);
    expect(marks.every((m) => !/bg/.test(m.cls))).toBe(true);
  });
});

describe('LaTeX highlighting · math', () => {
  it('inline math: delimiters, body and math commands are three colors', () => {
    const src = 'texto $x^2 + \\frac{a}{b}$ texto\n';
    expect(clsOf(src, '$', 0)).toBe('cm-lx-mathdelim');
    expect(clsOf(src, '$', 1)).toBe('cm-lx-mathdelim');
    expect(clsOf(src, '\\frac')).toBe('cm-lx-mathcmd');
    expect(classes(src).has('cm-lx-mathbody')).toBe(true);
  });

  it('math does not leak out of its delimiters', () => {
    const src = 'antes $x$ despues\n';
    const after = classifyLatex(src).filter((m) => m.from > src.lastIndexOf('$'));
    expect(after).toEqual([]);
  });

  it('display math spans several lines', () => {
    const src = '\\[\n  a = b\n\\]\nfuera\n';
    expect(clsOf(src, '\\[')).toBe('cm-lx-mathdelim');
    expect(clsOf(src, '  a = b')).toBe('cm-lx-mathbody');
    expect(clsOf(src, '\\]')).toBe('cm-lx-mathdelim');
    const outside = classifyLatex(src).filter((m) => m.from >= src.indexOf('fuera'));
    expect(outside).toEqual([]);
  });

  it('a math environment colors its body, and \\end closes it', () => {
    const src = '\\begin{align}\n  a &= b\n\\end{align}\nfuera\n';
    expect(classes(src).has('cm-lx-mathbody')).toBe(true);
    expect(clsOf(src, '&')).toBe('cm-lx-amp');
    const outside = classifyLatex(src).filter((m) => m.from >= src.indexOf('fuera'));
    expect(outside).toEqual([]);
  });

  it('the alignment ampersand shows through the math body (TeXstudio priority 5)', () => {
    const src = '\\begin{tabular}{ll}\n a & b \\\\\n\\end{tabular}\n';
    expect(clsOf(src, '&')).toBe('cm-lx-amp');
  });

  it('a stray $ does not tint the rest of the document past a blank line', () => {
    const src = 'roto $ sin cerrar\n\nparrafo nuevo sin color\n';
    const tail = classifyLatex(src).filter((m) => m.from >= src.indexOf('parrafo'));
    expect(tail).toEqual([]);
  });
});

describe('LaTeX highlighting · verbatim and comments', () => {
  it('a verbatim body is inert — no commands, no math, no comments inside', () => {
    const src = '\\begin{verbatim}\n\\noescapa {x} $y$ %z\n\\end{verbatim}\n';
    expect(clsOf(src, '\\noescapa {x} $y$ %z')).toBe('cm-lx-verbatim');
    expect(classes(src).has('cm-lx-mathdelim')).toBe(false);
    expect(classes(src).has('cm-lx-comment')).toBe(false);
  });

  it('lstlisting keeps its option list as LaTeX but its body verbatim', () => {
    const src = '\\begin{lstlisting}[language=Python]\ndef f(): pass\n\\end{lstlisting}\n';
    expect(clsOf(src, 'def f(): pass')).toBe('cm-lx-verbatim');
    expect(clsOf(src, '[language=Python]')).toBe(null);
  });

  it('\\verb|…| is verbatim up to its closing delimiter', () => {
    const src = 'antes \\verb|$x$| despues\n';
    expect(clsOf(src, '|$x$|')).toBe('cm-lx-verbatim');
  });

  it('%, %TODO and % !TeX are three different comment formats', () => {
    expect(clsOf('% normal\n', '% normal')).toBe('cm-lx-comment');
    expect(clsOf('% TODO arreglar\n', '% TODO arreglar')).toBe('cm-lx-todo');
    expect(clsOf('% !TeX program = xelatex\n', '% !TeX program = xelatex')).toBe('cm-lx-magic');
  });

  it('an escaped percent is not a comment', () => {
    const src = 'sube un \\% mas\n';
    expect(classes(src).has('cm-lx-comment')).toBe(false);
  });
});

describe('LaTeX highlighting · pictures and the Pyx bridge', () => {
  it('a tikzpicture body and its commands are the picture formats', () => {
    const src = '\\begin{tikzpicture}\n  \\draw (0,0) rectangle (1,1);\n\\end{tikzpicture}\n';
    expect(clsOf(src, '\\draw')).toBe('cm-lx-picturekw');
    expect(classes(src).has('cm-lx-picture')).toBe(true);
  });

  it('\\py keeps its own color — it is Pyx\u2019s addition, not a TeXstudio format', () => {
    expect(clsOf('valor \\py{M}\n', '\\py')).toBe('cm-lx-py');
  });
});

describe('LaTeX highlighting · robustness', () => {
  it('never throws and always returns ranges inside the text', () => {
    const cases = ['', '\\', '$', '\\begin{', '\\end{}', '%', '\\verb', '\\[',
      '\\begin{verbatim}\nsin cerrar\n', '&&&', '\\begin{align}\n'];
    for (const src of cases) {
      expect(() => classifyLatex(src)).not.toThrow();
      for (const m of classifyLatex(src)) {
        expect(m.to).toBeGreaterThan(m.from);
        expect(m.to).toBeLessThanOrEqual(src.length);
      }
    }
  });

  it('marks come back sorted', () => {
    const src = '\\section{A}\n$x$ \\textbf{b} % c\n';
    let prev = -1;
    for (const m of classifyLatex(src)) {
      expect(m.from).toBeGreaterThanOrEqual(prev);
      prev = m.from;
    }
  });
});
