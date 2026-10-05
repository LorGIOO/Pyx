import { describe, it, expect } from 'vitest';
import { importsOf } from '../js/compile/py-imports.js';

describe('importsOf (kernel warm-up)', () => {
  it('reads plain, dotted, aliased and multiple imports', () => {
    expect(importsOf('import numpy as np\nimport os, sys\nimport matplotlib.pyplot as plt'))
      .toEqual(['numpy', 'os', 'sys', 'matplotlib.pyplot']);
  });

  it('reads from-imports, including a handcalcs cell', () => {
    expect(importsOf('from scipy.optimize import fsolve\nimport handcalcs.render\n%%render\na = 1'))
      .toEqual(['scipy.optimize', 'handcalcs.render']);
  });

  it('reads indented imports and parenthesised lists', () => {
    expect(importsOf('try:\n    import pint\nexcept ImportError:\n    pass\nfrom math import (sqrt,\n  pi)'))
      .toEqual(['pint', 'math']);
  });

  it('ignores relative imports, strings and comments', () => {
    const code = [
      'from . import local',
      'from .pkg import x',
      '# import secret',
      'doc = """',
      'import not_this',
      '"""',
      "s = 'import nor_this'",
      'import real  # comment',
    ].join('\n');
    expect(importsOf(code)).toEqual(['real']);
  });

  it('is empty for code without imports', () => {
    expect(importsOf('x = 1\nprint(x)')).toEqual([]);
    expect(importsOf('')).toEqual([]);
    expect(importsOf(undefined)).toEqual([]);
  });
});
