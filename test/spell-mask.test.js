import { describe, it, expect } from 'vitest';
import { maskLine, isAcronym, WORD } from '../js/editor/spell-mask.js';

// Writing `\` inside a JS string literal in this file is a constant source of
// mistakes, so the fixtures are built from a named constant instead.
const B = String.fromCharCode(92);

// What the checker would actually look at: the words that survive masking.
function words(line) {
  const masked = maskLine(line);
  WORD.lastIndex = 0;
  const out = [];
  let m;
  while ((m = WORD.exec(masked))) {
    const w = m[0];
    if (w.length >= 2 && !isAcronym(w) && !/\d/.test(w)) out.push(w);
  }
  return out;
}

describe('maskLine keeps offsets', () => {
  it('never changes the length of the line', () => {
    const lines = [
      `${B}includegraphics[width=3cm]{figuras/viga.png}`,
      `Texto $a+b$ y ${B}(c${B}) fin`,
      `Antes % un comentario con faltass`,
      `${B}verb|codigo| despues`,
      `${B}begin{figure}[H]`,
    ];
    for (const l of lines) expect(maskLine(l)).toHaveLength(l.length);
  });

  it('blanks in place, so a surviving word keeps its column', () => {
    const line = `${B}ref{eq:viga} palabra`;
    expect(maskLine(line).indexOf('palabra')).toBe(line.indexOf('palabra'));
  });
});

describe('command names that are prefixes of other command names', () => {
  // The bug: `include` came before `includegraphics` in the alternation, so
  // every figure in a real document left a "graphics" to be spell-checked.
  it('masks \\includegraphics whole, leaving no "graphics"', () => {
    expect(words(`Ver ${B}includegraphics[width=3cm]{figuras/viga.png} arriba`))
      .toEqual(['Ver', 'arriba']);
  });

  it('masks \\includepdf whole', () => {
    expect(words(`${B}includepdf[pages=-]{anexos/plano.pdf} fin`)).toEqual(['fin']);
  });

  it('still masks the short \\include and \\input', () => {
    expect(words(`${B}include{capitulos/intro} ${B}input{preambulo} ok`)).toEqual(['ok']);
  });

  it('masks \\bibliographystyle without leaving "style"', () => {
    expect(words(`${B}bibliographystyle{plainnat} fin`)).toEqual(['fin']);
  });

  it('masks \\pyfile without leaving "file"', () => {
    expect(words(`${B}pyfile{scripts/viga.py} fin`)).toEqual(['fin']);
  });

  it('masks \\definecolor without leaving "inecolor"', () => {
    expect(words(`${B}definecolor{acento}{RGB}{0,90,160} fin`)).toEqual(['fin']);
  });
});

describe('an unlisted command is not eaten as a listed prefix', () => {
  // `\reflectbox` starts with `ref`. Without the end-of-name lookahead the
  // NOPROSE rule took `\ref` and handed "lectbox" to the dictionary; the
  // catch-all command rule must be the one that handles it, and it keeps the
  // braced argument, which here IS prose.
  it('treats \\reflectbox{Texto} as a command with a prose argument', () => {
    expect(words(`${B}reflectbox{Texto} fin`)).toEqual(['Texto', 'fin']);
  });

  // An unlisted command falls through to the catch-all, which blanks the NAME
  // and leaves every braced argument as prose — right for `\reflectbox`, and
  // merely harmless here. What matters is that no fragment of the name itself
  // ("ormat") ever reaches the dictionary.
  it('does not leave "ormat" behind for \\Crefformat', () => {
    expect(words(`${B}Crefformat{equation}{Texto} fin`)).toEqual(['equation', 'Texto', 'fin']);
  });
});

describe('the rest of the masking rules', () => {
  it('drops comments', () => {
    expect(words('Texto % comentario conn faltas')).toEqual(['Texto']);
  });
  it('keeps an escaped percent and the prose after it', () => {
    expect(words(`Rendimiento del 95${B}% en total`)).toEqual(['Rendimiento', 'del', 'en', 'total']);
  });
  it('drops inline math', () => {
    expect(words('Sea $x_{ij}$ y tambien \\(y_k\\) ahora')).toEqual(['Sea', 'tambien', 'ahora']);
  });
  it('drops \\verb and its delimited body', () => {
    expect(words(`Usa ${B}verb|pip instal numpy| ahora`)).toEqual(['Usa', 'ahora']);
  });
  it('drops optional arguments', () => {
    expect(words(`${B}begin{figure}[htbp] Pie`)).toEqual(['Pie']);
  });
  it('keeps the prose argument of a formatting command', () => {
    expect(words(`${B}textbf{Conclusiones} del ${B}emph{estudio}`))
      .toEqual(['Conclusiones', 'del', 'estudio']);
  });
  it('drops \\cite variants with their keys', () => {
    expect(words(`Segun ${B}citep{euro2004} y ${B}cite{ache08} lo anterior`))
      .toEqual(['Segun', 'lo', 'anterior']);
  });
});
