// \pynotebook{…}: which calls a document makes, where they point.
import { describe, it, expect } from 'vitest';
import { notebookRefs, notebookPath } from '../js/editor/notebooks.js';

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
      { raw: 'calculos/modelo.ipynb', line: 3 },
      { raw: '../999. Recursos/hidro', line: 11 },
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
});
