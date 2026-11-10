// \pyfile{…}: a Python script linked like a notebook.
import { describe, it, expect } from 'vitest';
import { notebookRefs, notebookPath, splitPyCells } from '../js/editor/notebooks.js';

describe('\\pyfile: archivos .py vinculados', () => {
  it('\\pyfile{} es como \\pynotebook{}, y acepta .py', () => {
    expect(notebookRefs('\\pyfile{datos.py}\n\\pynotebook{oleaje}\n% \\pyfile{apagado.py}').map((r) => r.raw))
      .toEqual(['datos.py', 'oleaje']);
    expect(notebookPath('C:/P', 'datos.py')).toMatch(/datos\.py$/);
    expect(notebookPath('C:/P', 'oleaje')).toMatch(/oleaje\.ipynb$/);
    // Without extension the COMMAND decides: \pyfile{datos} is datos.py (it
    // used to look for datos.ipynb and say the notebook was missing).
    expect(notebookPath('C:/P', 'datos', 'pyfile')).toBe('C:/P/datos.py');
    expect(notebookPath('C:/P', 'datos', 'pynotebook')).toBe('C:/P/datos.ipynb');
    expect(notebookRefs('\\pyfile{datos}\n\\pynotebook{oleaje}').map((r) => r.cmd)).toEqual(['pyfile', 'pynotebook']);
  });

  it('las celdas de un .py son sus bloques # %% (o el archivo entero)', () => {
    const one = splitPyCells('import math\nx = 1\n');
    expect(one).toHaveLength(1);
    expect(one[0].source).toBe('import math\nx = 1\n');
    expect(one[0].id).toMatch(/^py-/);
    const cells = splitPyCells([
      '"""Cabecera"""',
      '# %% Datos',
      'Hs = 2.5',
      '# %% [markdown]',
      '# Texto que no es código',
      '#%%',
      'T = 8',
      '# In[3]:',
      'E = Hs * T',
    ].join('\n'));
    expect(cells.map((c) => c.source.trim())).toEqual(['"""Cabecera"""', 'Hs = 2.5', 'T = 8', 'E = Hs * T']);
    expect(new Set(cells.map((c) => c.id)).size).toBe(4);
  });

  it('una celda conserva su identidad cuando se inserta otra delante', () => {
    const before = splitPyCells('# %%\nHs = 2.5\n# %%\nT = 8\n');
    const after = splitPyCells('# %%\nimport math\n# %%\nHs = 2.5\n# %%\nT = 8\n');
    // By position they were py1, py2 → py2, py3: every cell looked new and
    // the whole script ran again.
    expect(after.slice(1).map((c) => c.id)).toEqual(before.map((c) => c.id));
    // Two cells with the same code are still two cells.
    const twin = splitPyCells('# %%\nx = 1\n# %%\nx = 1\n');
    expect(twin[0].id).not.toBe(twin[1].id);
  });
});
