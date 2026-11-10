// \pynotebook{…}: which calls a document makes, where they point, and what
// the document takes from the notebook (its values, not its code).
import { describe, it, expect } from 'vitest';
import {
  notebookRefs, notebookPath, linkCandidates, notebookDefs, documentReads, documentDefs, linkInfo, notebookCodeHash,
} from '../js/editor/notebooks.js';
import { planRun, executePlan } from '../js/editor/dep-plan.js';
import { analyzePython } from '../js/editor/py-deps.js';

const sorted = (s) => [...s].sort();
const nbCell = (code) => ({ code, codeHash: code });

describe('\\pynotebook: qué toma el documento del cuaderno', () => {
  it('las variables que define el cuaderno; null si una celda no se puede seguir', () => {
    const cells = [nbCell('import numpy as np\n%matplotlib inline\ndf = carga()'), nbCell('Q_max = df.q.max()\ndef factor(x):\n    return x')];
    expect(sorted(notebookDefs(cells))).toEqual(['Q_max', 'df', 'factor', 'np']);
    expect(notebookDefs([nbCell('from math import *')])).toBe(null);
    expect(notebookDefs([nbCell('exec("a = 1")')])).toBe(null);
  });

  it('lo que lee el documento: sus celdas, \\py{} y \\pyif{}, sin funciones integradas', () => {
    const reads = documentReads(['Q_dis = factor(Q_max)\nn = len(df)', 'tabla.append(1)'], ['round(Q_dis, 2)', 'g > 9']);
    expect(sorted(reads)).toEqual(['Q_dis', 'Q_max', 'df', 'factor', 'g', 'tabla']);
    expect(documentReads(['exec("x")'], [])).toBe(null);
    expect(sorted(documentDefs(['Q_dis = 1', 'import pandas as pd']))).toEqual(['Q_dis', 'pd']);
  });

  it('la huella del código cambia solo si cambia el código de alguna celda', () => {
    const a = [nbCell('a = 1'), nbCell('b = a')];
    expect(notebookCodeHash(a)).toBe(notebookCodeHash([nbCell('a = 1'), nbCell('b = a')]));
    expect(notebookCodeHash(a)).not.toBe(notebookCodeHash([nbCell('a = 2'), nbCell('b = a')]));
  });

  it('los módulos del cuaderno son importaciones para el planificador', () => {
    const info = linkInfo(['np', 'df'], new Map([['np', 'numpy']]));
    expect(sorted(info.defs)).toEqual(['df', 'np']);
    expect(info.binds.get('np')).toBe('numpy');
    expect(sorted(info.plain)).toEqual(['df']);
    expect(info.reads.size).toBe(0);
  });
});

describe('\\pynotebook: los valores en el plan, sin ejecutar el cuaderno', () => {
  // The notebook as ONE entry that defines its values; the document's cells after it.
  const program = (token) => [
    { key: 'nb::valores', hash: token, info: linkInfo(['Q_max', 'df']) },
    { key: 'doc::a', hash: 'a', info: analyzePython('Q_dis = Q_max * 1.25') },
    { key: 'doc::b', hash: 'b', info: analyzePython('n = len(df)') },
    { key: 'doc::c', hash: 'c', info: analyzePython('texto = "fijo"') },
  ];
  const ranAll = (p) => new Map(p.map((e) => [e.key, { hash: e.hash, D: new Set(e.info.defs), reads: [], stale: false }]));

  it('mismos valores: no se carga ni se ejecuta nada', () => {
    const p = program('t1');
    const plan = planRun({ program: p, ran: ranAll(p) });
    expect(plan.mode).toBe('graph');
    expect(plan.run).toEqual([]);
  });

  it('valores nuevos: se cargan, y solo se re-ejecuta lo que cambió de verdad', async () => {
    const before = program('t1');
    const p = program('t2');
    const plan = planRun({ program: p, ran: ranAll(before) });
    const ran = [];
    await executePlan(plan, {
      // Only Q_max changed in Jupyter: df is reported unchanged.
      run: async (i) => { ran.push(p[i].key); return { ok: true, unchanged: i === 0 ? ['df'] : [] }; },
    });
    expect(ran).toEqual(['nb::valores', 'doc::a']);
  });
});

describe('\\pynotebook: los cuadernos que enlaza un documento', () => {
  it('encuentra cada llamada con su línea, y no las comentadas, mostradas ni dentro de celdas', () => {
    const text = [
      '\\documentclass{article}',
      '\\begin{document}',
      '\\pynotebook{calculos/modelo.ipynb}',
      '% \\pynotebook{viejo.ipynb}',
      '\\begin{verbatim}',
      '\\pynotebook{ejemplo.ipynb}',
      '\\end{verbatim}',
      '%#python',
      's = r"\\pynotebook{no}"',
      '%#end',
      'Texto \\pynotebook{ ../999. Recursos/hidro } y más.',
      '\\end{document}',
    ].join('\n');
    expect(notebookRefs(text)).toEqual([
      { raw: 'calculos/modelo.ipynb', line: 3, cmd: 'pynotebook' },
      { raw: '../999. Recursos/hidro', line: 11, cmd: 'pynotebook' },
    ]);
    expect(notebookRefs('sin cuadernos')).toEqual([]);
  });

  it('la ruta es relativa a la carpeta del documento raíz, y .ipynb se añade si falta', () => {
    expect(notebookPath('C:/Proyecto/1. Main', '../999. Recursos/hidro')).toMatch(/999\. Recursos[\\/]hidro\.ipynb$/);
    expect(notebookPath('C:/Proyecto/1. Main', 'modelo.ipynb')).toMatch(/1\. Main[\\/]modelo\.ipynb$/);
    expect(notebookPath('C:/Proyecto', 'D:/datos/c.ipynb')).toBe('D:/datos/c.ipynb');
    expect(notebookPath('/home/u/p', '/srv/n.ipynb')).toBe('/srv/n.ipynb');
    // An unsaved document has no folder: a relative path cannot be resolved.
    expect(notebookPath(undefined, 'modelo')).toBe(null);
    expect(notebookPath(null, 'C:/datos/modelo.ipynb')).toBe('C:/datos/modelo.ipynb');
  });

  it('una misma ruta escrita de varias formas es UNA clave (editor y compilador)', () => {
    // joinPath alone gave `C:\P\calc/a.ipynb`, `C:\P\./a.ipynb`…: each one a
    // different key in the run ledger and in the kernel's scopes.
    const same = [
      notebookPath('C:\\P', 'calc/a.ipynb'),
      notebookPath('C:\\P', './calc/a.ipynb'),
      notebookPath('C:\\P', 'calc\\a.ipynb'),
      notebookPath('C:\\P', 'otra/../calc/a'),
      notebookPath('C:\\P\\calc', '../calc/a.ipynb'),
    ];
    expect(new Set(same)).toEqual(new Set(['C:\\P\\calc\\a.ipynb']));
    expect(notebookPath('/home/u/p', './n/../m')).toBe('/home/u/p/m.ipynb');
    // Accents and spaces survive untouched; UNC keeps its two leading slashes.
    expect(notebookPath('C:\\Mi Proyecto\\1. Cálculo', 'año/oleaje ñ')).toBe('C:\\Mi Proyecto\\1. Cálculo\\año\\oleaje ñ.ipynb');
    expect(notebookPath('\\\\servidor\\obra', 'datos/a.py')).toBe('\\\\servidor\\obra\\datos\\a.py');
    expect(notebookPath('C:/P', '\\\\servidor\\obra\\a.ipynb')).toBe('\\\\servidor\\obra\\a.ipynb');
  });

  it('los candidatos: carpeta raíz, luego la del archivo; la extensión del comando primero', () => {
    expect(linkCandidates('C:/P', 'datos', 'pyfile', 'C:/P/cap')).toEqual([
      'C:/P/datos.py', 'C:/P/datos.ipynb', 'C:/P/cap/datos.py', 'C:/P/cap/datos.ipynb',
    ]);
    expect(linkCandidates('C:/P', 'datos', 'pynotebook', 'C:/P')).toEqual(['C:/P/datos.ipynb', 'C:/P/datos.py']);
    expect(linkCandidates('C:/P', 'n.ipynb', 'pynotebook', 'C:/P/cap')).toEqual(['C:/P/n.ipynb', 'C:/P/cap/n.ipynb']);
    expect(linkCandidates('C:/P', 'D:/x/n.ipynb', 'pynotebook', 'C:/P/cap')).toEqual(['D:/x/n.ipynb']);
    expect(linkCandidates(null, 'n', 'pynotebook', null)).toEqual([]);
  });

  it('una celda con un error de sintaxis no obliga a ejecutar el cuaderno entero', () => {
    // Live compile runs between keystrokes: `E = Hs *` is half a line.
    const reads = documentReads(['E = Hs *', 'print(T)'], ['E']);
    expect(reads).not.toBe(null);
    expect(sorted(reads)).toEqual(expect.arrayContaining(['E', 'Hs', 'T']));
    // What truly cannot be followed still says so.
    expect(documentReads(['exec("x = 1")'], [])).toBe(null);
  });
});
