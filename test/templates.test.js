import { describe, it, expect } from 'vitest';
import { fillTemplate, templatize } from '../js/solid/stores/templatesStore.js';
import { tableParts, figureParts } from '../js/editor/table-gen.js';
import { fileNameOf } from '../js/core/userfiles.js';

const TABLE = String.raw`\begin{table}[htbp]
  \centering
  \caption{{{caption}}}
  \label{tab:{{label}}}
  \begin{tabular}{{{colspec}}}
    \toprule
    {{header}}
    \midrule
    {{rows}}
    \bottomrule
  \end{tabular}
\end{table}
`;

describe('templates', () => {
  const parts = tableParts({ cells: [['A', 'B'], ['1', '2'], ['3', '4']], align: ['l', 'r'], header: true, headerBold: true });

  it('fills placeholders, indents multi-line values, drops lines left empty', () => {
    const out = fillTemplate(TABLE, parts);
    expect(out).toContain('\\begin{tabular}{lr}');
    expect(out).toContain('    \\textbf{A} & \\textbf{B} \\\\');
    expect(out).toContain('    1 & 2 \\\\\n    3 & 4 \\\\');
    expect(out).not.toContain('\\caption');
    expect(out).not.toContain('\\label');
  });

  it('turns filled code back into the template', () => {
    const p = { ...parts, caption: 'Cargas', label: 'cargas' };
    expect(templatize(fillTemplate(TABLE, p), p)).toBe(TABLE);
  });

  it('figure pieces', () => {
    const f = figureParts({ images: [{ path: 'img/a.png' }], unit: 'textwidth', width: 0.6, angle: 90 });
    expect(f).toMatchObject({ path: 'img/a.png', width: '0.6\\textwidth', options: 'width=0.6\\textwidth, angle=90' });
  });

  it('file names are safe', () => {
    expect(fileNameOf('Tabla: bonita / v2')).toBe('Tabla- bonita - v2.tex');
    expect(fileNameOf('')).toBe('plantilla.tex');
  });
});
