import { describe, it, expect } from 'vitest';
import {
  parseCellsText, cellAtLine, cellKey, codeHashMap, markerId,
} from '../js/editor/cell-parse.js';

describe('markerId', () => {
  it('reads the stable id from an opening marker', () => {
    expect(markerId('%#python id=a1b2c3d4')).toBe('a1b2c3d4');
    expect(markerId('  %#python   id = zz9 ')).toBe('zz9');
  });
  it('is null for a legacy marker with no id', () => {
    expect(markerId('%#python')).toBe(null);
  });
});

describe('parseCellsText', () => {
  it('finds cells and reports 1-based marker lines', () => {
    const cells = parseCellsText([
      'Texto',
      '%#python id=aaa',
      'x = 1',
      'y = 2',
      '%#end',
      'Más texto',
    ].join('\n'));
    expect(cells).toHaveLength(1);
    expect(cells[0].id).toBe('aaa');
    expect(cells[0].headerLine).toBe(2);
    expect(cells[0].endLine).toBe(5);
    expect(cells[0].code).toBe('x = 1\ny = 2');
  });

  it('keeps two identical cells apart', () => {
    // The old store keyed results by a hash of the CODE, so these two shared
    // one entry: running either marked both as running.
    const cells = parseCellsText(
      '%#python id=one\nprint(1)\n%#end\n%#python id=two\nprint(1)\n%#end');
    expect(cells).toHaveLength(2);
    expect(cellKey(cells[0])).not.toBe(cellKey(cells[1]));
    expect(cells[0].codeHash).toBe(cells[1].codeHash); // same code…
  });

  it('falls back to the ordinal when a cell has no id', () => {
    const cells = parseCellsText('%#python\na\n%#end\n%#python\nb\n%#end');
    expect(cells.map(cellKey)).toEqual(['#0', '#1']);
  });

  it('ignores markers shown inside a verbatim environment', () => {
    // A document that DOCUMENTS the cell syntax is showing code, not running it.
    const cells = parseCellsText([
      '\\begin{lstlisting}',
      '%#python',
      'no soy una celda',
      '%#end',
      '\\end{lstlisting}',
      '%#python id=real',
      'si lo soy',
      '%#end',
    ].join('\n'));
    expect(cells).toHaveLength(1);
    expect(cells[0].id).toBe('real');
  });

  it('does not swallow the document when %#end is missing', () => {
    const cells = parseCellsText('%#python id=x\ncode\nsin cierre');
    expect(cells).toHaveLength(0); // reported as a problem by the compiler
  });

  it('handles CRLF documents', () => {
    const cells = parseCellsText('%#python id=w\r\nx=1\r\n%#end\r\n');
    expect(cells).toHaveLength(1);
    expect(cells[0].code).toBe('x=1');
  });

  it('changes the code fingerprint when the body changes', () => {
    const a = parseCellsText('%#python id=k\nx=1\n%#end')[0];
    const b = parseCellsText('%#python id=k\nx=2\n%#end')[0];
    expect(a.codeHash).not.toBe(b.codeHash);
  });
});

describe('cellAtLine', () => {
  const cells = parseCellsText([
    'a',                 // 1
    '%#python id=p',     // 2
    'x=1',               // 3
    '%#end',             // 4
    'b',                 // 5
    '%#python id=q',     // 6
    'y=2',               // 7
    '%#end',             // 8
  ].join('\n'));

  it('finds the enclosing cell, markers included', () => {
    expect(cellAtLine(cells, 2).id).toBe('p');
    expect(cellAtLine(cells, 3).id).toBe('p');
    expect(cellAtLine(cells, 4).id).toBe('p');
    expect(cellAtLine(cells, 7).id).toBe('q');
  });
  it('returns null outside every cell', () => {
    expect(cellAtLine(cells, 1)).toBe(null);
    expect(cellAtLine(cells, 5)).toBe(null);
    expect(cellAtLine(cells, 99)).toBe(null);
  });
  it('agrees with a linear scan on every line', () => {
    const linear = (ln) => cells.find((c) => ln >= c.headerLine && ln <= c.endLine) || null;
    for (let ln = 1; ln <= 10; ln++) {
      expect(cellAtLine(cells, ln)).toBe(linear(ln));
    }
  });
});

describe('cellKey', () => {
  it('agrees between the editor parser and the compiler analyzer', () => {
    // The compiler builds its own cell objects while walking the \input tree.
    // If their SHAPE drifts from the parser's, results get filed under a key
    // nothing reads back — a silent, invisible failure. Pin the contract.
    const fromParser = parseCellsText('%#python id=abc\nx\n%#end\n%#python\ny\n%#end');
    const fromAnalyzer = [
      { code: 'x', headerLn: 1, id: 'abc', index: 0 },
      { code: 'y', headerLn: 4, id: null, index: 1 },
    ];
    expect(fromAnalyzer.map(cellKey)).toEqual(fromParser.map(cellKey));
    expect(fromParser.map(cellKey)).toEqual(['abc', '#1']);
  });
});

describe('codeHashMap', () => {
  it('maps each cell key to its code fingerprint', () => {
    const cells = parseCellsText('%#python id=a\nx\n%#end\n%#python\ny\n%#end');
    const m = codeHashMap(cells);
    expect([...m.keys()]).toEqual(['a', '#1']);
    expect(m.get('a')).toBe(cells[0].codeHash);
  });
});
