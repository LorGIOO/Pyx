import { describe, it, expect } from 'vitest';
import { parseTodos, parseChanges } from '../js/solid/stores/structureStore.js';

describe('«Por hacer» and «Cambios»', () => {
  it('lists notes of LaTeX, of values and of Python cells', () => {
    const src = [
      'Texto \\todo[color=red]{Revisar {\\bfseries esto}}', // 1
      '\\missingfigure{resultado}',                          // 2
      'El valor es \\py{M} % FIXME: unidades',               // 3
      '%#python',                                            // 4
      'x = 1  # TODO: comprobar la carga',                   // 5
      '%#end',                                               // 6
      '% POR HACER: conclusiones',                           // 7
      '50\\% de \\celda{B2}',                                // 8
    ].join('\n');
    const t = parseTodos(src);
    expect(t.map((x) => [x.kind, x.line, x.text])).toEqual([
      ['todo', 1, 'Revisar esto'], ['figure', 2, 'resultado'], ['note', 3, 'unidades'],
      ['py', 5, 'comprobar la carga'], ['note', 7, 'conclusiones'],
    ]);
    expect(t[2].on).toBe('py');
  });
  it('lists the changes of a compared document', () => {
    const src = '\\documentclass{article}\n\\providecommand{\\DIFadd}[1]{#1}\n\\begin{document}\nUno \\DIFdel{dos} \\DIFadd{tres} \\DIFadd{cuatro}\n\\DIFdelbegin\\DIFblock{red}{-- figure}\\DIFdelend\n\\end{document}';
    expect(parseChanges(src)).toEqual([
      { type: 'del', text: 'dos', line: 4, block: false },
      { type: 'add', text: 'tres cuatro', line: 4, block: false },
      { type: 'del', text: '-- figure', line: 5, block: true },
    ]);
  });
});
