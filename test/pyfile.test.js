// \pyfile{…}: a Python script linked like a notebook.
import { describe, it, expect } from 'vitest';
import { notebookRefs, notebookPath, splitPyCells } from '../js/editor/notebooks.js';

describe('\\pyfile: archivos .py vinculados', () => {
  it('\\pyfile{} es como \\pynotebook{}, y acepta .py', () => {
    expect(notebookRefs('\\pyfile{datos.py}\n\\pynotebook{oleaje}\n% \\pyfile{apagado.py}').map((r) => r.raw))
      .toEqual(['datos.py', 'oleaje']);
    expect(notebookPath('C:/P', 'datos.py')).toMatch(/datos\.py$/);
    expect(notebookPath('C:/P', 'oleaje')).toMatch(/oleaje\.ipynb$/);
  });

  it('las celdas de un .py son sus bloques # %% (o el archivo entero)', () => {
    expect(splitPyCells('import math\nx = 1\n')).toEqual([{ source: 'import math\nx = 1\n', id: 'py1' }]);
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
    expect(cells.map((c) => [c.id, c.source.trim()])).toEqual([
      ['py1', '"""Cabecera"""'], ['py2', 'Hs = 2.5'], ['py4', 'T = 8'], ['py5', 'E = Hs * T'],
    ]);
  });
});
