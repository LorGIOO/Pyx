import { describe, it, expect } from 'vitest';
import { parseControlLine, formatValue, sliderRange } from '../js/editor/controls.js';

describe('cell controls (# @slider …)', () => {
  it('reads a slider with its bounds, step and label', () => {
    const c = parseControlLine('L = 6.0  # @slider(1, 12, 0.5) Luz (m)');
    expect(c).toMatchObject({ name: 'L', kind: 'slider', value: 6, args: [1, 12, 0.5], label: 'Luz (m)', raw: '6.0' });
    expect('L = 6.0  # @slider'.slice(c.valueFrom, c.valueTo)).toBe('6.0');
  });

  it('reads inputs, selects and checkboxes', () => {
    expect(parseControlLine('q = 10 # @input Carga')).toMatchObject({ kind: 'input', value: 10, label: 'Carga' });
    expect(parseControlLine('p = "IPE" # @select("IPE", "HEB")')).toMatchObject({ kind: 'select', value: 'IPE', args: ['IPE', 'HEB'] });
    expect(parseControlLine('ok = True # @check')).toMatchObject({ kind: 'check', value: true });
  });

  it('ignores expressions and plain comments', () => {
    expect(parseControlLine('L = a + b  # @slider(1, 10)')).toBeNull();
    expect(parseControlLine('L = 5  # luz')).toBeNull();
  });

  it('writes values back in the same style', () => {
    const s = parseControlLine('L = 6.0  # @slider(1, 12, 0.5)');
    expect(formatValue(s, '7.5')).toBe('7.5');
    expect(formatValue(s, '7')).toBe('7.0');
    const i = parseControlLine('n = 3  # @slider(1, 10)');
    expect(sliderRange(i)).toEqual({ min: 1, max: 10, step: 1 });
    expect(formatValue(i, '4')).toBe('4');
    const f = parseControlLine('x = 6.0  # @input');
    expect(formatValue(f, 7)).toBe('7.0');
    expect(formatValue(parseControlLine("p = 'IPE' # @select('IPE', 'HEB')"), 'HEB')).toBe("'HEB'");
    expect(formatValue(parseControlLine('ok = True # @check'), false)).toBe('False');
  });
});
