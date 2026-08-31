import { describe, it, expect } from 'vitest';
import {
  findPyExprs, resolvePyText, findPyIfExprs, resolvePyIf, collectPyIfConds, pyifKey,
  neutralizeCells, buildToSrcLine, srcToBuildLine, findPyxLeaks, safetyPreamble,
  injectPreamble, protectedRanges, createVerbatimTracker,
} from '../js/compile/latex-bridge.js';

const ok = (v) => ({ ok: true, value: v });

describe('findPyExprs', () => {
  it('matches balanced braces so f-strings survive', () => {
    const t = 'Área = \\py{f"{a:.2f}"} m²';
    const [e] = findPyExprs(t);
    expect(e.expr).toBe('f"{a:.2f}"');
    expect(t.slice(e.start, e.end)).toBe('\\py{f"{a:.2f}"}');
  });
  it('ignores occurrences inside verbatim', () => {
    const t = '\\begin{verbatim}\n\\py{x}\n\\end{verbatim}\n\\py{y}';
    expect(findPyExprs(t).map((e) => e.expr)).toEqual(['y']);
  });
  it('ignores occurrences inside inline \\verb', () => {
    expect(findPyExprs('\\verb|\\py{x}| y \\py{z}').map((e) => e.expr)).toEqual(['z']);
  });
  it('costs nothing on a file with no \\py at all', () => {
    expect(findPyExprs('sólo prosa')).toEqual([]);
  });
});

describe('resolvePyText', () => {
  it('substitutes values', () => {
    expect(resolvePyText('A=\\py{a} B=\\py{b}', { a: ok('2'), b: ok('3') })).toBe('A=2 B=3');
  });
  it('emits NOTHING for a failed expression', () => {
    // The PDF is the deliverable: it must never carry a trace of the incident.
    expect(resolvePyText('A=\\py{a}!', { a: { ok: false, value: 'NameError' } })).toBe('A=!');
  });
  it('turns \\py*{…} into literal, typeset-safe text', () => {
    expect(resolvePyText('\\py*{a+1}', {})).toBe('\\texttt{\\detokenize{\\py{a+1}}}');
  });
});

describe('pyif', () => {
  it('selects the branch its condition picks', () => {
    const vm = { [pyifKey('x>1')]: ok('True') };
    expect(resolvePyIf('\\pyif{x>1}{sí}{no}', vm)).toBe('sí');
    expect(resolvePyIf('\\pyif{x>1}{sí}{no}', { [pyifKey('x>1')]: ok('False') })).toBe('no');
  });
  it('treats the else group as optional', () => {
    const one = findPyIfExprs('\\pyif{c}{a}')[0];
    expect(one.thenText).toBe('a');
    expect(one.elseText).toBe('');
    expect(resolvePyIf('\\pyif{c}{a}', { [pyifKey('c')]: ok('False') })).toBe('');
  });
  it('resolves nesting inside the selected branch', () => {
    const vm = { [pyifKey('a')]: ok('True'), [pyifKey('b')]: ok('False') };
    expect(resolvePyIf('\\pyif{a}{\\pyif{b}{X}{Y}}{Z}', vm)).toBe('Y');
  });
  it('collects nested conditions for evaluation', () => {
    expect(collectPyIfConds('\\pyif{a}{\\pyif{b}{X}{Y}}{Z}')).toEqual(['a', 'b']);
  });
});

describe('neutralizeCells', () => {
  const doc = [
    '\\section{Uno}',   // 1
    '%#python id=aaa',  // 2
    'x = 1',            // 3
    '%#end',            // 4
    'Texto final',      // 5
  ].join('\n');

  it('removes a plain cell entirely from the build', () => {
    const { text } = neutralizeCells(doc);
    expect(text).toBe('\\section{Uno}\nTexto final');
  });

  it('maps every build line back to its source line', () => {
    const { srcLines } = neutralizeCells(doc);
    expect(srcLines).toEqual([1, 5]);
    expect(buildToSrcLine(srcLines, 2)).toBe(5);
  });

  it('substitutes a handcalcs cell by its STABLE key', () => {
    const { text, srcLines } = neutralizeCells(doc, { aaa: '\\[ x = 1 \\]' });
    expect(text).toBe('\\section{Uno}\n\\[ x = 1 \\]\nTexto final');
    // The rendered block reports the cell's own header line.
    expect(srcLines).toEqual([1, 2, 5]);
  });

  it('does not let two identical cells share one rendered block', () => {
    // Keyed by CODE (as it used to be), both cells would have emitted the same
    // block. Keyed by id, only the cell that produced it does.
    const two = '%#python id=one\nc\n%#end\n%#python id=two\nc\n%#end';
    const { text } = neutralizeCells(two, { one: 'PRIMERO' });
    expect(text).toBe('PRIMERO');
    expect(text.match(/PRIMERO/g)).toHaveLength(1);
  });

  it('numbers id-less cells so legacy documents still line up', () => {
    const two = '%#python\nc\n%#end\n%#python\nc\n%#end';
    expect(neutralizeCells(two, { '#1': 'SEGUNDO' }).text).toBe('SEGUNDO');
  });

  it('leaves markers inside verbatim untouched', () => {
    const src = '\\begin{minted}{python}\n%#python\ncode\n%#end\n\\end{minted}';
    expect(neutralizeCells(src).text).toBe(src);
  });

  it('returns the text unchanged when there are no cells', () => {
    const plain = 'sin celdas';
    expect(neutralizeCells(plain)).toEqual({ text: plain, srcLines: null });
  });
});

describe('line map translation', () => {
  const map = [1, 2, 7, 8]; // lines 3..6 were a cell that the build dropped
  it('translates build → source', () => {
    expect(buildToSrcLine(map, 3)).toBe(7);
    expect(buildToSrcLine(null, 42)).toBe(42); // identity with no map
  });
  it('translates source → build, landing at or after the line', () => {
    expect(srcToBuildLine(map, 7)).toBe(3);
    expect(srcToBuildLine(map, 4)).toBe(3); // inside the removed cell
    expect(srcToBuildLine(map, 1)).toBe(1);
  });
  it('round-trips every mapped line', () => {
    for (let i = 0; i < map.length; i++) {
      expect(buildToSrcLine(map, srcToBuildLine(map, map[i]))).toBe(map[i]);
    }
  });
});

describe('findPyxLeaks', () => {
  it('reports an unresolved token with its build line', () => {
    const leaks = findPyxLeaks('línea uno\n\\py{roto');
    expect(leaks).toEqual([{ line: 2, token: '\\py' }]);
  });
  it('does not report an escaped \\py* that was already rewritten', () => {
    expect(findPyxLeaks('\\texttt{\\detokenize{\\py{a}}}')).toEqual([]);
  });
  it('does not report tokens inside verbatim', () => {
    expect(findPyxLeaks('\\begin{verbatim}\n\\py{x}\n\\end{verbatim}')).toEqual([]);
  });
});

describe('safetyPreamble', () => {
  it('guards graphicx when a \\py{} could expand into a figure', () => {
    const block = safetyPreamble({ envs: new Set(), styles: new Set(), usesPy: true });
    expect(block).toContain('\\@ifundefined{includegraphics}{\\usepackage{graphicx}}{}');
    expect(block).toContain('\\providecommand\\pyif[3]{}');
  });
  it('provides the packages a verbatim environment needs', () => {
    const block = safetyPreamble({ envs: new Set(['lstlisting']), styles: new Set(['mio']) });
    expect(block).toContain('\\usepackage{listings}');
    expect(block).toContain('lst@style@mio');
  });
  it('is null when nothing needs guarding', () => {
    expect(safetyPreamble({ envs: new Set(), styles: new Set(), usesPy: false })).toBe(null);
  });
});

describe('injectPreamble', () => {
  it('inserts before \\begin{document} and reports the shift', () => {
    const src = '\\documentclass{article}\n\\begin{document}\nhola\n\\end{document}';
    const r = injectPreamble(src, 'A\nB');
    expect(r.atIndex).toBe(1);
    expect(r.count).toBe(2);
    expect(r.text.split('\n').slice(0, 4)).toEqual(
      ['\\documentclass{article}', 'A', 'B', '\\begin{document}']);
  });
  it('is null for an \\input fragment with no preamble', () => {
    expect(injectPreamble('sólo texto', 'A')).toBe(null);
  });
});

describe('protectedRanges', () => {
  it('is memoized by content, not by identity', () => {
    const a = 'x\n\\begin{verbatim}\ny\n\\end{verbatim}';
    const b = ['x', '\\begin{verbatim}', 'y', '\\end{verbatim}'].join('\n');
    expect(protectedRanges(a)).toBe(protectedRanges(b)); // same array instance
  });
});

describe('createVerbatimTracker', () => {
  it('only closes on the matching \\end', () => {
    const t = createVerbatimTracker();
    expect(t('\\begin{verbatim}')).toBe(true);
    expect(t('\\end{minted}')).toBe(true);   // wrong env: still inside
    expect(t('\\end{verbatim}')).toBe(true); // the closing line itself
    expect(t('prosa')).toBe(false);
  });
});
