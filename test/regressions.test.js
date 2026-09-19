// Regression tests for bugs found by the QA campaign of 2026-09-19. Each one
// names the bug it guards against; see CHANGELOG.md for the user-facing story.

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { safetyPreamble, injectPreamble } from '../js/compile/latex-bridge.js';

const src = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

describe('BUG-001 · projects outside the home folder', () => {
  // plugin-fs only reaches the folders its scope lists: a project on another
  // drive could not be read, written or even probed, and `exists` answering
  // "no" silently left `\input{x.pltx}` untranslated. Every file operation
  // must go through Pyx's own commands.
  it('platform.js does not use @tauri-apps/plugin-fs for file access', () => {
    const code = src('js/core/platform.js');
    expect(code).not.toMatch(/from '@tauri-apps\/plugin-fs'/);
    expect(code).not.toMatch(/\bfs\.(readTextFile|writeTextFile|writeFile|exists)\(/);
  });
  it('the commands it relies on are registered in the backend', () => {
    const lib = src('src-tauri/src/lib.rs');
    for (const cmd of ['write_text', 'write_bytes', 'path_exists', 'read_file_bytes']) {
      expect(lib).toMatch(new RegExp(`\\n\\s+${cmd},`));
    }
  });
});

// The real engines, when this machine has one (CI has no TeX: skipped there).
const engine = ['xelatex', 'pdflatex'].find((e) => {
  const r = spawnSync(e, ['--version'], { encoding: 'utf8' });
  return r.status === 0;
});

// BUG-003 and the rule that came with it: a linked file that is not there —
// image, PDF, chapter, listing — never stops the document and is never an
// error. It shows as "No encontrado: <path>" and is logged as a warning.
describe.skipIf(!engine)('BUG-003 · missing linked files never stop the document', () => {
  it(`${engine}: no errors, a complete PDF, one warning per missing file`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyx-missing-'));
    try {
      const doc = [
        '\\documentclass{article}',
        '\\usepackage{graphicx}\\usepackage{pdfpages}\\usepackage{listings}\\usepackage{verbatim}',
        '\\begin{document}',
        // Under xelatex this one alone used to lose the whole PDF.
        'A \\includegraphics[width=5cm, height=!]{no-existe.png} FIN-A',
        'B \\includegraphics[width=3cm]{sin-extension} FIN-B', // was an error
        'C \\input{capitulo-que-falta} FIN-C', // aborted the whole compile
        'D \\lstinputlisting{codigo-que-falta.py} FIN-D', // aborted it too
        'E \\verbatiminput{nota-que-falta.txt} FIN-E',
        '\\includepdf[pages=-]{anexo-que-falta.pdf}', // a cascade of errors
        'F FIN-F',
        '\\include{parte-que-falta}',
        'G FIN-G',
        '\\end{document}',
      ].join('\n');
      const shim = safetyPreamble({ envs: new Set(), styles: new Set(), usesGraphics: true });
      writeFileSync(join(dir, 't.tex'), injectPreamble(doc, shim).text);
      const run = spawnSync(engine, ['-interaction=nonstopmode', 't.tex'],
        { cwd: dir, encoding: 'utf8', timeout: 120000 });
      const log = readFileSync(join(dir, 't.log'), 'latin1');
      expect(log.match(/^! .*/gm) || []).toEqual([]); // not one error
      expect(run.status).toBe(0);
      // Complete: a trailer at the end. Without the guards xelatex's xdvipdfmx
      // died on the first image and left a truncated file (or none).
      expect(readFileSync(join(dir, 't.pdf')).subarray(-1024).toString('latin1')).toContain('%%EOF');
      for (const f of ['no-existe.png', 'sin-extension', 'capitulo-que-falta', 'codigo-que-falta.py',
        'nota-que-falta.txt', 'anexo-que-falta.pdf', 'parte-que-falta.tex']) {
        expect(log).toContain(`File \`${f}' not found`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180000);
});

describe('log parser · names wrapped at 79 columns', () => {
  // TeX wraps its log at 79 columns and the working directory's paths are
  // long, so the root build file's name is split across two lines. The
  // fragment "…_Raiz.build.te" looks like a file with an extension; taking it
  // as the whole name listed every root-file problem under that fragment, with
  // build-copy line numbers instead of source lines.
  it('joins the name, so the problem maps to the real file and source line', async () => {
    const { parseLatexLog } = await import('../js/compile/log-parser.js');
    const first = '(C:/Users/Usuario/AppData/Local/Pyx/build/_Raiz-62c6b07e682827af/_Raiz.build.te';
    expect(first.length).toBe(79);
    const log = [first, 'x', '',
      "LaTeX Warning: File `figura-que-falta.png' not found on input line 24.", '', ')'].join('\n');
    // Build lines 1-12 are the source's, then 12 guard lines were inserted:
    // build line n (n > 12) is source line n - 12.
    const map = Array.from({ length: 40 }, (_, i) => (i < 12 ? i + 1 : Math.max(12, i + 1 - 12)));
    const [p] = parseLatexLog(log, {
      rootFile: '_Raiz.build.tex',
      buildMap: { '_raiz.build.tex': 'C:/proyecto/_Raiz.pltx' },
      knownFiles: new Set(['_raiz.pltx', '_raiz.build.tex']),
      lineMaps: { '_raiz.build.tex': map },
    });
    expect(p.file).toBe('C:/proyecto/_Raiz.pltx');
    expect(p.line).toBe(12); // build line 24 → source line 12
    expect(p.severity).toBe('warning');
  });
});
