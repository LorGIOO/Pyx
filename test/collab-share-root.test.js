// @vitest-environment jsdom
// Which folder a session shares: the project's «carpeta madre», found from
// what the root document pulls in — not only the folder of the preamble.
import { describe, it, expect, vi, beforeAll } from 'vitest';

const disk = {
  '/home/ana/tesis/capitulos/cap1.tex': 'Capítulo 1 \\input{../capitulos/cap2}',
  '/home/ana/tesis/capitulos/cap2.tex': 'Capítulo 2 \\includegraphics{../figuras/plano.pdf}',
};

vi.mock('../js/core/platform.js', async () => {
  const real = await vi.importActual('../js/core/platform.js');
  return {
    ...real,
    isTauri: () => false,
    readSources: async (paths) => paths.map((p) => disk[p] ?? null),
  };
});
const root = vi.hoisted(() => ({ dir: '/home/ana/tesis/preambulo' }));
vi.mock('../js/compile/compiler.js', () => ({
  activeRootDir: async () => root.dir,
}));

let app, setup, state;
beforeAll(async () => {
  if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [];
  ({ state } = await import('../js/core/state.js'));
  setup = await import('../js/editor/setup.js');
  app = await import('../js/collab/app.js');
});

function openDoc(id, path, text) {
  setup.registerDoc(id, text);
  const doc = { id, fileName: path.split('/').pop(), path, modified: false };
  state.documents.push(doc);
  return doc;
}

describe('collab · carpeta madre del proyecto', () => {
  it('sube hasta la carpeta común de preámbulo, capítulos, figuras y bibliografía', async () => {
    const doc = openDoc(91, '/home/ana/tesis/preambulo/main.tex', [
      '\\documentclass{book}',
      '\\begin{document}',
      '\\input{../capitulos/cap1}',
      '\\bibliography{../biblio/refs}',
      '\\end{document}',
    ].join('\n'));
    expect(await app.detectShareRoot(doc)).toBe('/home/ana/tesis');
  });

  it('un proyecto que no sale de su carpeta comparte esa carpeta', async () => {
    root.dir = '/home/ana/informe';
    const doc = openDoc(92, '/home/ana/informe/main.tex', '\\input{caps/uno}');
    expect(await app.detectShareRoot(doc)).toBe('/home/ana/informe');
    root.dir = '/home/ana/tesis/preambulo';
  });

  it('nunca propone algo tan arriba como la raíz del disco por sí solo', async () => {
    const doc = openDoc(93, '/home/ana/tesis/preambulo/raro.tex', '\\input{../../../../../etc/algo}');
    const f = await app.detectShareRoot(doc);
    expect(f).toBe('/home/ana/tesis/preambulo');
  });

  it('un documento sin guardar no tiene carpeta', async () => {
    expect(await app.detectShareRoot({ id: 94, kind: undefined, path: null })).toBeNull();
  });
});
