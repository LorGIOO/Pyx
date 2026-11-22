import { describe, it, expect } from 'vitest';
import { parseCellOptions, formatNumber, resolveSheets } from '../js/compile/sheets.js';

describe('\\celda: options', () => {
  it('reads Python format specs, keywords and templates in any order', () => {
    expect(parseCellOptions('.3f')).toMatchObject({ spec: '.3f', errors: [] });
    expect(parseCellOptions(',.2f')).toMatchObject({ spec: ',.2f' });
    expect(parseCellOptions('abs, .2f')).toMatchObject({ abs: true, spec: '.2f' });
    expect(parseCellOptions('T')).toMatchObject({ transpose: true });
    expect(parseCellOptions('coma, ,.2f')).toMatchObject({ comma: true, spec: ',.2f' });
    expect(parseCellOptions('cmd=\\textbf, .1f')).toMatchObject({ cmds: ['\\textbf'], spec: '.1f' });
    expect(parseCellOptions('color=red')).toMatchObject({ color: 'red' });
    expect(parseCellOptions('{:.2f}\\,kN')).toMatchObject({ template: '{:.2f}\\,kN', errors: [] });
    expect(parseCellOptions('foo, .2f').errors).toEqual(['foo']);
  });
});

describe('\\celda: numbers like Python format()', () => {
  it.each([
    [3.14159, '.3f', {}, '3.142'],
    [-1234567.891, ',.2f', {}, '-1{,}234{,}567.89'],
    [1234567.891, ',.2f', { comma: true }, '1\\,234\\,567{,}89'],
    [0.1234, '.1%', {}, '12.3\\%'],
    [12345.678, '.3e', {}, '\\ensuremath{1.235\\times10^{4}}'],
    [42.5, '+.0f', {}, '+43'],
    [3.14159, '.3', {}, '3.14'],
  ])('%s with %s', (v, spec, o, out) => {
    expect(formatNumber(v, spec, o)).toBe(out);
  });
});

describe('\\celda: LaTeX around it', () => {
  const row = { ok: true, grid: [[1.234, -2.5, 'a_b']] };
  const one = { ok: true, grid: [[-12.3456]] };
  const val = (r) => (r.ref === 'E4' ? one : row);
  it('a wrapper around a RANGE goes onto every cell', () => {
    expect(resolveSheets('\\hoja{a.xlsx} \\textbf{\\celda[.1f]{E1:G1}}', null, val).text)
      .toBe('\\relax{} \\textbf{1.2} & \\textbf{-2.5} & \\textbf{a\\_b}');
    expect(resolveSheets('\\hoja{a.xlsx} $\\celda{E1:G1}$', null, val).text)
      .toBe('\\relax{} $1.234$ & $-2.5$ & $a\\_b$');
    expect(resolveSheets('\\hoja{a.xlsx} \\textcolor{red}{\\celda{E1:G1}}', null, val).text)
      .toBe('\\relax{} \\textcolor{red}{1.234} & \\textcolor{red}{-2.5} & \\textcolor{red}{a\\_b}');
  });
  it('a single cell is plain text inside any LaTeX', () => {
    expect(resolveSheets('\\hoja{a.xlsx} $\\celda[abs,.2f]{E4}$', null, val).text).toBe('\\relax{} $12.35$');
    expect(resolveSheets('\\hoja{a.xlsx} \\celda[{:.2f}\\,kN]{E4}', null, val).text).toBe('\\relax{} -12.35\\,kN');
    expect(resolveSheets('\\hoja{a.xlsx} \\celda[coma,.3f]{E4}', null, val).text).toBe('\\relax{} -12{,}346');
  });
  it('an unknown option is reported, the value still placed', () => {
    const r = resolveSheets('\\hoja{a.xlsx} \\celda[raro]{E4}', null, val);
    expect(r.text).toBe('\\relax{} -12.3456');
    expect(r.problems).toHaveLength(1);
  });
});
