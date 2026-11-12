// What the table and figure assistants write, and the relative paths they
// build: this is LaTeX the user compiles without reading it first.

import { describe, it, expect } from 'vitest';
import { tableLatex, tablePackages, figureLatex, figurePackages, slugLabel } from '../js/editor/table-gen.js';
import { relativePath } from '../js/core/paths.js';

describe('asistente de tabla', () => {
  const cells = [['Caso', 'F (kN)'], ['Peso propio', '12,5'], ['Viento 50%', '3']];

  it('tabla con booktabs, cabecera en negrita, título arriba y etiqueta', () => {
    const tex = tableLatex({
      cells, align: ['l', 'r'], rules: 'booktabs', header: true, headerBold: true,
      float: 'htbp', caption: 'Cargas', label: 'cargas',
    });
    expect(tex.split('\n')).toEqual([
      '\\begin{table}[htbp]',
      '  \\centering',
      '  \\caption{Cargas}',
      '  \\label{tab:cargas}',
      '  \\begin{tabular}{lr}',
      '    \\toprule',
      '    \\textbf{Caso} & \\textbf{F (kN)} \\\\',
      '    \\midrule',
      '    Peso propio & 12,5 \\\\',
      '    Viento 50\\% & 3 \\\\',
      '    \\bottomrule',
      '  \\end{tabular}',
      '\\end{table}',
    ]);
    expect(tablePackages({ rules: 'booktabs', float: 'htbp' })).toEqual(['booktabs']);
  });

  it('cuadrícula completa: una línea tras cada fila y entre columnas', () => {
    const tex = tableLatex({ cells, rules: 'grid', float: 'none' });
    expect(tex).toContain('\\begin{tabular}{|l|l|}');
    expect((tex.match(/\\hline/g) || []).length).toBe(4);
  });

  it('sin escapar: el LaTeX de las celdas se respeta', () => {
    const tex = tableLatex({ cells: [['$x^2$', '\\textbf{a}']], escape: false, rules: 'none', float: 'none' });
    expect(tex).toContain('$x^2$ & \\textbf{a} \\\\');
  });

  it('filas desiguales se completan; columna de párrafo; título abajo; [H] pide float', () => {
    const tex = tableLatex({
      cells: [['a', 'b', 'c'], ['d']], align: ['p', 'c', 'r'], pWidth: '4cm', rules: 'hline',
      float: 'H', caption: 'T', captionPos: 'bottom', fit: true, size: 'small',
    });
    expect(tex).toContain('\\begin{tabular}{p{4cm}cr}');
    expect(tex).toContain('d &  &  \\\\');
    expect(tex.indexOf('\\caption{T}')).toBeGreaterThan(tex.indexOf('\\end{tabular}'));
    expect(tex).toContain('\\resizebox{');
    expect(tex).toContain('\\small');
    expect(tablePackages({ rules: 'hline', float: 'H', fit: true })).toEqual(['graphicx', 'float']);
  });
});

describe('asistente de figura', () => {
  it('una imagen: ancho relativo, pie abajo, etiqueta', () => {
    const tex = figureLatex({
      images: [{ path: '../999. Recursos/2. Imagenes/planta.pdf' }], unit: 'textwidth', width: 0.8,
      float: 'htbp', caption: 'Planta', label: 'planta',
    });
    expect(tex.split('\n')).toEqual([
      '\\begin{figure}[htbp]',
      '  \\centering',
      '  \\includegraphics[width=0.8\\textwidth]{../999. Recursos/2. Imagenes/planta.pdf}',
      '  \\caption{Planta}',
      '  \\label{fig:planta}',
      '\\end{figure}',
    ]);
  });

  it('ancho y alto a la vez conservan la proporción; rotación', () => {
    const tex = figureLatex({ images: [{ path: 'a.png' }], unit: 'cm', width: 12, height: 8, angle: 90, float: 'none', centering: false });
    expect(tex).toBe('\\includegraphics[width=12cm, height=8cm, keepaspectratio, angle=90]{a.png}');
  });

  it('varias imágenes: subfiguras que caben en la fila, con su título', () => {
    const tex = figureLatex({
      images: [{ path: 'a.png', caption: 'Antes' }, { path: 'b.png', caption: 'Después' }, { path: '' }],
      float: 'htbp', caption: 'Comparación',
    });
    expect((tex.match(/\\begin\{subfigure\}/g) || []).length).toBe(2);
    expect(tex).toContain('\\begin{subfigure}[b]{0.48\\textwidth}');
    expect(tex).toContain('\\hfill');
    expect(tex).toContain('\\caption{Antes}');
    expect(figurePackages({ images: [{ path: 'a' }, { path: 'b' }] })).toEqual(['graphicx', 'subcaption']);
  });

  it('etiqueta a partir del nombre del archivo', () => {
    expect(slugLabel('Ajuste Log-Normal (NW).pdf')).toBe('ajuste-log-normal-nw');
    expect(slugLabel('Sección de cálculo')).toBe('seccion-de-calculo');
  });
});

describe('ruta relativa a la carpeta del documento raíz', () => {
  it('debajo de la carpeta', () => {
    expect(relativePath('C:\\Proyecto\\1. Main', 'C:\\Proyecto\\1. Main\\img\\a.png')).toBe('img/a.png');
  });
  it('en una carpeta hermana: sube con ..', () => {
    expect(relativePath('E:/Trabajo/1. Main', 'E:\\Trabajo\\999. Recursos\\2. Imagenes\\a.pdf')).toBe('../999. Recursos/2. Imagenes/a.pdf');
  });
  it('en otra unidad no hay ruta relativa: absoluta con barras normales', () => {
    expect(relativePath('C:/Proyecto', 'E:\\Fotos\\a.png')).toBe('E:/Fotos/a.png');
  });
  it('sin carpeta base, la ruta tal cual', () => {
    expect(relativePath('', 'C:\\a\\b.png')).toBe('C:/a/b.png');
  });
});
