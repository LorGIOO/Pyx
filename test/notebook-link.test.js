// @vitest-environment jsdom
// \pynotebook end to end on the JS side: cell-runner.js resolveNotebook,
// runLinkEntry and saveNotebookValues against the REAL kernel (only the Tauri
// bridge is replaced, by a pipe to kernel.py), with the real ledger.
//
// Everything is private to the test: Pyx's data folder (the snapshots) and
// the Jupyter runtime folder. The "VS Code" Jupyter kernel of the last test is
// one this test starts itself, in that private folder — no kernel of the
// machine is ever seen.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// (jsdom: import.meta.url is not a file URL here; vitest runs from the repo.)
const KERNEL = join(process.cwd(), 'src-tauri', 'python', 'kernel.py');
const python = ['python', 'python3', 'py'].find((exe) => spawnSync(exe, ['-c', 'pass']).status === 0);
const hasIpykernel = !!python && spawnSync(python, ['-c', 'import ipykernel']).status === 0;

const base = mkdtempSync(join(tmpdir(), 'pyx-nb-'));
const runtime = join(base, 'runtime');
const local = join(base, 'local');
mkdirSync(runtime);
mkdirSync(local);
const env = {
  ...process.env,
  JUPYTER_RUNTIME_DIR: runtime,
  LOCALAPPDATA: local,
  XDG_DATA_HOME: local,
  HOME: base,
  MPLBACKEND: 'Agg',
};

// The kernel behind the "Tauri bridge".
let proc = null;
let buf = '';
const waiting = new Map();
// How many requests of each kind about linked files reached the kernel.
const asked = vi.hoisted(() => ({}));
function startKernel() {
  proc = spawn(python, ['-u', KERNEL], { stdio: ['pipe', 'pipe', 'ignore'], env, cwd: base });
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('{')) continue;
      let frame;
      try { frame = JSON.parse(line); } catch (_) { continue; }
      const done = waiting.get(frame.id);
      if (done) { waiting.delete(frame.id); done(frame); }
    }
  });
}

vi.mock('../js/core/platform.js', async (orig) => ({
  ...(await orig()),
  isTauri: () => true,
  kernelStart: async () => ({ python: 'test' }),
  kernelSetPython: async () => ({ python: 'test' }),
  kernelReset: async () => {},
  kernelInterrupt: async () => {},
  // The real thing, from disk: what the remembered answers are checked against.
  fileStamps: async (paths) => paths.map((p) => {
    try {
      const s = statSync(p);
      return { mtime: Math.floor(s.mtimeMs), size: s.size };
    } catch (_) {
      return { mtime: -1, size: -1 };
    }
  }),
  readTextFile: async (p) => readFileSync(p, 'utf8'),
  kernelExec: (req) => new Promise((resolve, reject) => {
    if (req.nblink) asked[req.nblink] = (asked[req.nblink] || 0) + 1;
    const timer = setTimeout(() => reject(new Error('kernel did not answer')), 60000);
    waiting.set(req.id, (f) => { clearTimeout(timer); resolve(f); });
    proc.stdin.write(`${JSON.stringify(req)}\n`);
  }),
}));

const runner = await import('../js/editor/cell-runner.js');
const { hashString } = await import('../js/core/hash.js');

const nbDir = join(base, 'Calculos');
mkdirSync(nbDir);
const nbPath = join(nbDir, 'hidro.ipynb');
const cell = (code, i) => ({ code, codeHash: hashString(code), id: `nb-c${i}`, index: i, nth: i + 1, headerLn: 0, notebook: nbPath, dir: nbDir });
const cells = [
  cell('import math\nQ_max = 551.0', 0),
  cell('def factor(x):\n    return x * 1.25\ng = 9.81', 1),
];
const needed = new Set(['Q_max', 'factor']); // what the document reads

/** What compiler.js does with a plan: run its entries (cells or values). */
async function runPlan(plan) {
  for (const e of plan.entries) {
    if (e.link) {
      const r = await runner.runLinkEntry(e, base, { key: e.key });
      expect(r.ok).toBe(true);
    } else {
      const r = await runner.runCellCode(e.cell.code, { cwd: nbDir });
      expect(r.ok).toBe(true);
      runner.nsRecord(e.key, e.cell.codeHash, base, r.reads, new Set());
    }
  }
}
const value = async (expr) => (await runner.evalExpressions([expr], { cwd: base }))[expr].value;

describe.skipIf(!python)('\\pynotebook: resolveNotebook con el kernel real', { timeout: 90000 }, () => {
  beforeAll(() => startKernel());
  afterAll(() => {
    try { proc.stdin.end(); proc.kill(); } catch (_) { /* gone */ }
  });

  it('la primera vez, sin Jupyter ni copia: se ejecuta UNA vez y se guarda', async () => {
    const plan = await runner.resolveNotebook(nbPath, cells, needed, base);
    expect(plan.mode).toBe('run');
    expect(plan.names).toEqual(['Q_max', 'factor']);
    expect(plan.extras).toEqual(['g', 'math']);
    await runPlan(plan);
    const saved = await runner.saveNotebookValues(nbPath, plan, base);
    expect(saved.saved).toEqual(['Q_max', 'factor', 'g', 'math']);
    expect(runner.notebookNote(nbPath, plan, true)).toMatch(/ejecutado en Pyx.*no se volverá a ejecutar/);
  });

  it('en la misma sesión: ya está cargado, no se ejecuta ni se carga nada', async () => {
    const plan = await runner.resolveNotebook(nbPath, cells, needed, base);
    expect(plan.mode).toBe('run');
    expect(plan.ranHere).toBe(true);
    expect(runner.notebookNote(nbPath, plan, false)).toMatch(/ya cargado en esta sesión/);
  });

  it('en una sesión nueva: los valores guardados, sin ejecutar el cuaderno', async () => {
    await runner.runCellCode('', { cwd: base, reset: true });
    runner.nsReset(base);
    const plan = await runner.resolveNotebook(nbPath, cells, needed, base);
    expect(plan.mode).toBe('link');
    expect(plan.source).toBe('snapshot');
    expect(plan.entries).toHaveLength(1);
    await runPlan(plan);
    expect(await value('factor(Q_max)')).toBe('688.75');
    expect(runner.notebookNote(nbPath, plan, false)).toMatch(/guardadas \(de la última ejecución en Pyx.*sin ejecutar el cuaderno/);
  });

  it('"desde cero" (fresh) también toma los valores guardados', async () => {
    const plan = await runner.resolveNotebook(nbPath, cells, needed, base, { fresh: true });
    expect(plan.mode).toBe('link');
  });

  it('si cambia el código del cuaderno, hay que ejecutarlo (y se dice por qué)', async () => {
    const edited = [cells[0], cell('def factor(x):\n    return x * 1.5\ng = 9.81', 1)];
    const plan = await runner.resolveNotebook(nbPath, edited, needed, base, { fresh: true });
    expect(plan.mode).toBe('run');
    expect(plan.reason).toMatch(/código ha cambiado/);
  });

  it('código cambiado con Jupyter cerrado: se recupera lo anterior y solo queda por ejecutar la celda cambiada', async () => {
    await runner.runCellCode('', { cwd: base, reset: true });
    runner.nsReset(base);
    const edited = [cells[0], cell('def factor(x):\n    return x * 1.5\ng = 9.81', 1)];
    const plan = await runner.resolveNotebook(nbPath, edited, needed, base);
    expect(plan.mode).toBe('run');
    expect(plan.restored).toBe(1); // the first cell: unchanged, its values back
    expect(await value('Q_max')).toBe('551');
    expect(runner.nsHasRun([plan.entries[0]])).toBe(true);
    expect(runner.nsHasRun([plan.entries[1]])).toBe(false); // the edited one runs
    expect(runner.notebookNote(nbPath, plan, true)).toMatch(/1 celda sin cambios recuperada/);
    runner.nsReset(base);
  });

  it('un \\py{} nuevo que lee otra variable pequeña se sirve de la copia', async () => {
    const plan = await runner.resolveNotebook(nbPath, cells, new Set(['g']), base, { fresh: true });
    expect(plan.mode).toBe('link');
    expect(plan.names).toEqual(['g']);
  });

  it('sin cambios, volver a preguntar no llega al kernel (0 ms)', async () => {
    await runner.runCellCode('', { cwd: base, reset: true });
    runner.nsReset(base);
    await runner.resolveNotebook(nbPath, cells, needed, base);
    await runner.resolveNotebook(nbPath, cells, needed, base);
    const before = asked.fetch;
    const plan = await runner.resolveNotebook(nbPath, cells, needed, base);
    expect(asked.fetch).toBe(before); // answered from memory: one stat, no kernel
    expect(plan.mode).toBe('link');
    expect(plan.source).toBe('snapshot');
    await runPlan(plan);
    expect(await value('factor(Q_max)')).toBe('688.75');
    // «Recompilar desde cero» always asks; so does a document that reads other names.
    await runner.resolveNotebook(nbPath, cells, needed, base, { fresh: true });
    expect(asked.fetch).toBe(before + 1);
    await runner.resolveNotebook(nbPath, cells, new Set(['g']), base);
    expect(asked.fetch).toBe(before + 2);
  });

  it('una celda que falla: lo recuperado no se vuelve a cargar en cada compilación', async () => {
    await runner.runCellCode('', { cwd: base, reset: true });
    runner.nsReset(base);
    const broken = [cells[0], cell('def factor(x):\n    return x * 1.5\ng = 1 / 0', 1)];
    const first = await runner.resolveNotebook(nbPath, broken, needed, base);
    expect(first.mode).toBe('run');
    expect(first.restored).toBe(1);
    const restores = asked.restore;
    // The compile runs the broken cell, it fails, nothing is saved — and the
    // next compile finds the first cell's values where the restore left them.
    const again = await runner.resolveNotebook(nbPath, broken, needed, base);
    expect(asked.restore).toBe(restores);
    expect(again.mode).toBe('run');
    expect(again.resumed).toBe(true);
    expect(runner.nsHasRun([again.entries[0]])).toBe(true);
    expect(runner.nsHasRun([again.entries[1]])).toBe(false);
    expect(runner.notebookNote(nbPath, again, true)).toMatch(/sigue cargado; solo se ha ejecutado lo que faltaba/);
    // An emptied namespace holds none of it: restored again.
    await runner.runCellCode('', { cwd: base, reset: true });
    runner.nsReset(base);
    const third = await runner.resolveNotebook(nbPath, broken, needed, base);
    expect(third.restored).toBe(1);
    expect(asked.restore).toBe(restores + 1);
    runner.nsReset(base);
  });

  it('vigilancia: lo que cambia fuera de Pyx (datos, el propio archivo) pide una compilación', async () => {
    const watch = await import('../js/editor/link-watch.js');
    const { loadNotebook } = await import('../js/editor/notebooks.js');
    const pyPath = join(nbDir, 'aforo.py');
    const data = join(nbDir, 'aforo.txt');
    writeFileSync(data, '12');
    writeFileSync(pyPath, 'caudal = float(open("aforo.txt").read())\ndoble = caudal * 2\n');
    const reads = new Set(['doble']);
    await runner.runCellCode('', { cwd: base, reset: true });
    runner.nsReset(base);
    let pyCells = await loadNotebook(pyPath);
    let plan = await runner.resolveNotebook(pyPath, pyCells, reads, base);
    expect(plan.mode).toBe('run');
    await runPlan(plan);
    expect((await runner.saveNotebookValues(pyPath, plan, base)).saved).toContain('doble');
    // Another session: the saved values, nothing runs.
    await runner.runCellCode('', { cwd: base, reset: true });
    runner.nsReset(base);
    plan = await runner.resolveNotebook(pyPath, pyCells, reads, base);
    expect(plan.mode).toBe('link');
    await runPlan(plan);
    expect(await value('doble')).toBe('24');

    let calls = 0;
    watch.startLinkWatch(() => { calls++; });
    watch.stopLinkWatch(); // the test ticks by hand
    const link = () => ({ path: pyPath, needed: reads, cwd: base, codeHash: plan.codeHash, linked: plan.mode === 'link' });
    watch.setLinkWatch([link()]);
    const quiet = asked.fetch;
    expect(await watch.checkLinks()).toBe(false);
    expect(asked.fetch).toBe(quiet); // nothing moved: not even a question
    // The data file the script read changes: its saved values are stale.
    writeFileSync(data, '100');
    expect(await watch.checkLinks()).toBe(true);
    expect(calls).toBe(1);
    expect(await watch.checkLinks()).toBe(false); // said once
    expect(calls).toBe(1);
    // The compile it asked for: the cells run again (and the answer was
    // already fetched by the watcher — nothing is asked twice).
    const ready = asked.fetch;
    plan = await runner.resolveNotebook(pyPath, pyCells, reads, base);
    expect(plan.mode).toBe('run');
    expect(asked.fetch - ready).toBeLessThanOrEqual(1);
    await runPlan(plan);
    await runner.saveNotebookValues(pyPath, plan, base);
    expect(await value('doble')).toBe('200');

    // The script saved from another editor.
    watch.setLinkWatch([link()]);
    expect(await watch.checkLinks()).toBe(false);
    writeFileSync(pyPath, 'caudal = float(open("aforo.txt").read())\ndoble = caudal * 3  # corregido\n');
    expect(await watch.checkLinks()).toBe(true);
    expect(calls).toBe(2);
    expect(await watch.checkLinks()).toBe(false);
    pyCells = await loadNotebook(pyPath);
    plan = await runner.resolveNotebook(pyPath, pyCells, reads, base);
    expect(plan.mode).toBe('run');
    watch.setLinkWatch([]);
    runner.nsReset(base);
  });

  it('vigilancia: los datos que leyó un archivo EJECUTADO en esta sesión también se vigilan', async () => {
    const watch = await import('../js/editor/link-watch.js');
    const { loadNotebook } = await import('../js/editor/notebooks.js');
    const pyPath = join(nbDir, 'nivel.py');
    const data = join(nbDir, 'nivel.txt');
    writeFileSync(data, '3');
    writeFileSync(pyPath, 'nivel = float(open("nivel.txt").read())\ncota = nivel + 100\n');
    const reads = new Set(['cota']);
    await runner.runCellCode('', { cwd: base, reset: true });
    runner.nsReset(base);
    const pyCells = await loadNotebook(pyPath);
    let plan = await runner.resolveNotebook(pyPath, pyCells, reads, base);
    expect(plan.mode).toBe('run');
    await runPlan(plan);
    await runner.saveNotebookValues(pyPath, plan, base);
    // The next compile of the same session: already here, nothing runs.
    plan = await runner.resolveNotebook(pyPath, pyCells, reads, base);
    expect(plan.ranHere).toBe(true);
    const opened = [...new Set(runner.nsReads(plan.entries.map((e) => e.key)).map((r) => r.path))];
    expect(opened.map((p) => p.replace(/\\/g, '/').split('/').pop())).toEqual(['nivel.txt']);

    let calls = 0;
    watch.startLinkWatch(() => { calls++; });
    watch.stopLinkWatch();
    // What compiler.js hands over for a file whose cells ran here.
    watch.setLinkWatch([{ path: pyPath, needed: reads, cwd: base, codeHash: plan.codeHash, linked: false, reads: opened }]);
    expect(await watch.checkLinks()).toBe(false);
    expect(await watch.checkLinks()).toBe(false);
    writeFileSync(data, '40');
    expect(await watch.checkLinks()).toBe(true);
    expect(calls).toBe(1);
    expect(await watch.checkLinks()).toBe(false); // said once
    expect(calls).toBe(1);
    watch.setLinkWatch([]);
    runner.nsReset(base);
  });

  it.skipIf(!hasIpykernel)('con el cuaderno abierto en Jupyter: sus valores, en vivo', async () => {
    const cf = join(runtime, 'kernel-v3prueba.json');
    const jp = spawn(python, [
      '-m', 'ipykernel_launcher', '-f', cf,
      `--IPKernelApp.exec_lines=__vsc_ipynb_file__ = ${JSON.stringify(nbPath)}`,
      '--IPKernelApp.exec_lines=Q_max = 999.0',
      '--IPKernelApp.exec_lines=def factor(x):\n    return x * 2',
    ], { stdio: 'ignore', env });
    try {
      let plan = null;
      for (let i = 0; i < 120; i++) {
        if (existsSync(cf) && statSync(cf).size > 0) {
          plan = await runner.resolveNotebook(nbPath, cells, needed, base, { fresh: true });
          if (plan.mode === 'link' && plan.source === 'jupyter') break;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(plan && plan.source).toBe('jupyter');
      expect(plan.label).toBe('VS Code');
      await runPlan(plan);
      expect(await value('factor(Q_max)')).toBe('1998');
      expect(runner.notebookNote(nbPath, plan, false)).toMatch(/tomadas de Jupyter \(VS Code\).*sin ejecutar el cuaderno/);
    } finally {
      jp.kill();
    }
  });
});

afterAll(() => {
  try { rmSync(base, { recursive: true, force: true }); } catch (_) { /* in use */ }
});
