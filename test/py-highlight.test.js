// The Python palette must match what VSCode shows in a .py file. The reference
// values are not opinions: they come from the theme files VSCode ships
// (extensions/theme-defaults/themes/{dark,light}_{vs,plus}.json) combined with
// the scopes the MagicPython grammar assigns, plus Pylance's semantic tokens
// for the distinctions the grammar leaves open (calls, constants, namespaces).
//
// Each test names the VSCode scope it pins down, so a future change that
// "looks nicer" but drifts away from VSCode fails here.

import { describe, it, expect } from 'vitest';
import { classifyPython } from '../js/editor/py-highlight.js';

/** All classes assigned to a given token text. */
function clsOf(code, token, nth = 0) {
  const marks = classifyPython(code);
  const hits = marks.filter((m) => code.slice(m.from, m.to) === token);
  return hits[nth] ? hits[nth].cls : null;
}

/** Every (text -> class) pair, in document order. */
function pairs(code) {
  return classifyPython(code).map((m) => [code.slice(m.from, m.to), m.cls]);
}

describe('Python highlighting · keywords', () => {
  it('control flow and import are keyword.control, not storage', () => {
    const src = 'import os\nfrom math import pi\nfor i in x:\n    if i:\n        return i\n';
    expect(clsOf(src, 'import')).toBe('cm-py-control');
    expect(clsOf(src, 'from')).toBe('cm-py-control');
    expect(clsOf(src, 'for')).toBe('cm-py-control');
    expect(clsOf(src, 'if')).toBe('cm-py-control');
    expect(clsOf(src, 'return')).toBe('cm-py-control');
  });

  it('and/or/not/is are keyword.operator.logical — blue, NOT the purple of control', () => {
    // This is the single most visible difference from Pyx's old palette, which
    // painted them like `if`/`for`.
    const src = 'y = a and b or not c\nz = c is None\n';
    expect(clsOf(src, 'and')).toBe('cm-py-logic');
    expect(clsOf(src, 'or')).toBe('cm-py-logic');
    expect(clsOf(src, 'not')).toBe('cm-py-logic');
    expect(clsOf(src, 'is')).toBe('cm-py-logic');
  });

  it('`in` flips color: purple inside a for/comprehension, blue as a membership test', () => {
    // Verified by tokenizing through the real MagicPython grammar: the `in` of
    // a loop is keyword.control.flow, the `in` of `a in b` is
    // keyword.operator.logical. Same word, two colors.
    expect(clsOf('for k in d:\n    pass\n', 'in')).toBe('cm-py-control');
    expect(clsOf('xs = [k for k in d]\n', 'in')).toBe('cm-py-control');
    expect(clsOf('if k in d:\n    pass\n', 'in')).toBe('cm-py-logic');
    expect(clsOf('y = k not in d\n', 'in')).toBe('cm-py-logic');
  });

  it('def / class / lambda / global are storage.type', () => {
    const src = 'def f():\n    global g\nclass C:\n    pass\nh = lambda x: x\n';
    expect(clsOf(src, 'def')).toBe('cm-py-storage');
    expect(clsOf(src, 'class')).toBe('cm-py-storage');
    expect(clsOf(src, 'lambda')).toBe('cm-py-storage');
    expect(clsOf(src, 'global')).toBe('cm-py-storage');
  });

  it('async is storage in `async def` but control in `async for`', () => {
    expect(clsOf('async def f():\n    pass\n', 'async')).toBe('cm-py-storage');
    expect(clsOf('async for x in y:\n    pass\n', 'async')).toBe('cm-py-control');
  });
});

describe('Python highlighting · names', () => {
  it('a call is a function, its arguments are not', () => {
    const src = 'resultado = calcular(base, altura)\n';
    expect(clsOf(src, 'calcular')).toBe('cm-py-func');
    expect(clsOf(src, 'base')).toBe('cm-py-variable');
  });

  it('a method call is a function, a plain attribute is a property', () => {
    const src = 'v.momento(3)\nq = v.longitud\n';
    expect(clsOf(src, 'momento')).toBe('cm-py-func');
    expect(clsOf(src, 'longitud')).toBe('cm-py-property');
  });

  it('a class is a type at its definition AND at its call site', () => {
    const src = 'class Viga:\n    pass\nv = Viga(5)\n';
    expect(clsOf(src, 'Viga', 0)).toBe('cm-py-type');
    expect(clsOf(src, 'Viga', 1)).toBe('cm-py-type');
  });

  it('builtin functions and builtin types get different colors', () => {
    const src = 'print(len(x))\ny = int("3")\nz = float(2)\n';
    expect(clsOf(src, 'print')).toBe('cm-py-builtin');
    expect(clsOf(src, 'len')).toBe('cm-py-builtin');
    expect(clsOf(src, 'int')).toBe('cm-py-type');
    expect(clsOf(src, 'float')).toBe('cm-py-type');
  });

  it('exception names are types', () => {
    const src = 'raise ValueError("x")\n';
    expect(clsOf(src, 'ValueError')).toBe('cm-py-type');
  });

  it('ALL_CAPS names are constants (variable.other.constant)', () => {
    const src = 'MAX_ITER = 100\nn = MAX_ITER\nnormal = 2\n';
    expect(clsOf(src, 'MAX_ITER', 0)).toBe('cm-py-constant');
    expect(clsOf(src, 'MAX_ITER', 1)).toBe('cm-py-constant');
    expect(clsOf(src, 'normal')).toBe('cm-py-variable');
  });

  it('imported modules are namespaces, self is variable.language', () => {
    const src = 'import numpy as np\nclass C:\n    def m(self):\n        return self.x\n';
    expect(clsOf(src, 'numpy')).toBe('cm-py-namespace');
    expect(clsOf(src, 'np')).toBe('cm-py-namespace');
    expect(clsOf(src, 'self', 0)).toBe('cm-py-self');
    expect(clsOf(src, 'x')).toBe('cm-py-property');
  });

  it('parameters are parameters and annotations are types', () => {
    const src = 'class Viga:\n    pass\ndef f(a: int, v: Viga, b=2):\n    return a\n';
    expect(clsOf(src, 'a', 0)).toBe('cm-py-param');
    expect(clsOf(src, 'int')).toBe('cm-py-type');
    expect(clsOf(src, 'Viga', 1)).toBe('cm-py-type');
  });

  it('a decorator is colored like a function, including its @', () => {
    const src = '@staticmethod\ndef f():\n    pass\n';
    expect(clsOf(src, '@')).toBe('cm-py-decorator');
  });

  it('dunder names are magic, not plain variables', () => {
    const src = 'if __name__ == "__main__":\n    pass\n';
    expect(clsOf(src, '__name__')).toBe('cm-py-magic');
  });
});

describe('Python highlighting · literals', () => {
  it('numbers of every base are numbers', () => {
    const src = 'a = 255\nb = 1_000\nc = 3e-4\nd = 2.5\n';
    for (const n of ['255', '1_000', '3e-4', '2.5']) {
      expect(clsOf(src, n)).toBe('cm-py-number');
    }
  });

  it('a base prefix and an imaginary suffix are a DIFFERENT color from the digits', () => {
    // VSCode paints `0xDEADBEEF` in two colors and `4j` in two colors:
    // storage.type.number for the prefix/suffix, constant.numeric for the rest.
    const src = 'a = 0x1F\nb = 0b1010\nc = 4j\n';
    expect(clsOf(src, '0x')).toBe('cm-py-numprefix');
    expect(clsOf(src, '1F')).toBe('cm-py-number');
    expect(clsOf(src, '0b')).toBe('cm-py-numprefix');
    expect(clsOf(src, '1010')).toBe('cm-py-number');
    expect(clsOf(src, 'j')).toBe('cm-py-numprefix');
    expect(clsOf(src, '4')).toBe('cm-py-number');
  });

  it('a raw string is a different red, and the prefix letter is storage-colored', () => {
    const src = 'a = r"sin\\escape"\nb = "normal"\nc = b"bytes"\n';
    expect(clsOf(src, 'r"sin\\escape"')).toBe('cm-py-rawstring');
    expect(clsOf(src, '"normal"')).toBe('cm-py-string');
    expect(clsOf(src, 'r')).toBe('cm-py-strprefix');
    // (the first bare `b` is the variable on line 2; the second is the prefix)
    expect(clsOf(src, 'b', 1)).toBe('cm-py-strprefix');
    // …and a raw string really is raw: no escape inside it.
    expect(classifyPython(src).some((m) => m.cls === 'cm-py-escape')).toBe(false);
  });

  it('%s and {0} placeholders inside a string get the constant color', () => {
    const src = 's = "total %s de %d"\nt = "hola {0} y {nombre}"\n';
    expect(clsOf(src, '%s')).toBe('cm-py-placeholder');
    expect(clsOf(src, '%d')).toBe('cm-py-placeholder');
    expect(clsOf(src, '{0}')).toBe('cm-py-placeholder');
    expect(clsOf(src, '{nombre}')).toBe('cm-py-placeholder');
  });

  it('True / False / None are constant.language', () => {
    const src = 'a = True\nb = False\nc = None\n';
    expect(clsOf(src, 'True')).toBe('cm-py-atom');
    expect(clsOf(src, 'False')).toBe('cm-py-atom');
    expect(clsOf(src, 'None')).toBe('cm-py-atom');
  });

  it('an escape sequence inside a string gets its own color', () => {
    const src = 's = "linea\\nsigue"\n';
    expect(clsOf(src, '\\n')).toBe('cm-py-escape');
    expect(clsOf(src, '"linea\\nsigue"')).toBe('cm-py-string');
  });

  it('an f-string colors its braces and treats the inside as code', () => {
    const src = 's = f"valor {total:.2f}"\n';
    expect(clsOf(src, '{')).toBe('cm-py-fstring-brace');
    expect(clsOf(src, '}')).toBe('cm-py-fstring-brace');
    expect(clsOf(src, 'total')).toBe('cm-py-variable');
  });

  it('comments are comments and are not italic by decree (VSCode is not)', () => {
    expect(clsOf('# hola\n', '# hola')).toBe('cm-py-comment');
  });
});

describe('Python highlighting · f-strings and format specs', () => {
  // Found by tokenizing muestra.py through the real MagicPython grammar and
  // diffing against this module: a format spec is storage.type.format, not a
  // string, and the walk has to descend into it.
  it('the format spec, the !r conversion and the debug = are storage.type.format', () => {
    const src = 'x = 3\ns = f"{x!r:>8.2f}"\nd = f"{x=}"\n';
    expect(clsOf(src, '!r')).toBe('cm-py-format');
    expect(clsOf(src, ':>8.2f')).toBe('cm-py-format');
    // Three assignment `=` come first; the fourth is the debug one in `{x=}`.
    expect(clsOf(src, '=', 3)).toBe('cm-py-format');
  });

  it('a replacement nested inside a format spec is still code', () => {
    const src = 'x = 3\nh = 5\ns = f"{x:>{h}.2f}"\n';
    const hits = classifyPython(src).filter((m) => src.slice(m.from, m.to) === 'h');
    // `h` appears twice: the assignment and the nested replacement.
    expect(hits.length).toBe(2);
    expect(hits[1].cls).toBe('cm-py-variable');
  });

  it('doubled braces are escapes, and what sits between them is not a placeholder', () => {
    const src = 't = "llaves {{literales}} aqui"\n';
    expect(clsOf(src, '{{')).toBe('cm-py-escape');
    expect(clsOf(src, '}}')).toBe('cm-py-escape');
    expect(classifyPython(src).some((m) => m.cls === 'cm-py-placeholder')).toBe(false);
  });
});

describe('Python highlighting · soft keywords and decorators', () => {
  it('`type` in a PEP 695 alias keeps the builtin-type color, not the keyword one', () => {
    expect(clsOf('type Alias = int\n', 'type')).toBe('cm-py-type');
  });

  it('a dotted decorator is decorator-colored end to end, dots included', () => {
    const src = 'import mod\n@mod.deco(1)\ndef f():\n    pass\n';
    expect(clsOf(src, '@')).toBe('cm-py-decorator');
    expect(clsOf(src, 'mod', 1)).toBe('cm-py-decorator');
    expect(clsOf(src, '.')).toBe('cm-py-decorator');
    expect(clsOf(src, 'deco')).toBe('cm-py-decorator');
  });

  it('a dot outside a decorator is left alone', () => {
    const src = 'import os\np = os.path\n';
    expect(clsOf(src, '.')).toBe(null);
  });
});

describe('Python highlighting · Jupyter magics', () => {
  it('%%render and !pip do not derail the parser and get their own color', () => {
    const src = '%%render\nx = 4\ny = x * 3\n';
    expect(clsOf(src, '%%render')).toBe('cm-py-magiccmd');
    // The Python after the magic must still be colored normally.
    expect(clsOf(src, 'x', 0)).toBe('cm-py-variable');
    expect(clsOf(src, '3')).toBe('cm-py-number');
  });

  it('a shell escape line is a magic too', () => {
    expect(clsOf('!pip install numpy\n', '!pip install numpy')).toBe('cm-py-magiccmd');
  });
});

describe('Python highlighting · robustness', () => {
  it('never throws on broken code and still colors what it can', () => {
    for (const bad of ['def (:\n', 'x = "sin cerrar\n', '(((\n', '\u0000\n', 'if:\n']) {
      expect(() => classifyPython(bad)).not.toThrow();
    }
  });

  it('returns ranges inside the text, sorted, and never empty-width', () => {
    const src = 'import os\ndef f(a):\n    return os.path.join(a, "x")\n';
    const marks = classifyPython(src);
    expect(marks.length).toBeGreaterThan(5);
    let prev = -1;
    for (const m of marks) {
      expect(m.to).toBeGreaterThan(m.from);
      expect(m.from).toBeGreaterThanOrEqual(0);
      expect(m.to).toBeLessThanOrEqual(src.length);
      expect(m.from).toBeGreaterThanOrEqual(prev);
      prev = m.from;
    }
  });

  it('empty input is not a crash', () => {
    expect(classifyPython('')).toEqual([]);
    expect(classifyPython('\n\n')).toEqual([]);
  });

  it('a realistic engineering cell is fully classified', () => {
    const src = [
      'import numpy as np',
      'L = 5.0',
      'q = 12.5',
      'M_MAX = q * L ** 2 / 8',
      'm_med = M_MAX / 2',
      'print(f"M = {M_MAX:.2f} kN·m")',
    ].join('\n');
    const got = pairs(src);
    const byText = new Map(got.map(([t, c]) => [t, c]));
    expect(byText.get('np')).toBe('cm-py-namespace');
    expect(byText.get('M_MAX')).toBe('cm-py-constant');
    // Mixed case is NOT a constant — MagicPython asks for two upper-case
    // letters before it calls a name one, and so do we.
    expect(byText.get('m_med')).toBe('cm-py-variable');
    expect(byText.get('print')).toBe('cm-py-builtin');
    expect(byText.get('**')).toBe('cm-py-operator');
  });
});
