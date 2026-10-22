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
import { mkdtempSync, mkdirSync, rmSync, existsSync, statSync } from 'node:fs';
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
  kernelExec: (req) => new Promise((resolve, reject) => {
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

  it('un \\py{} nuevo que lee otra variable pequeña se sirve de la copia', async () => {
    const plan = await runner.resolveNotebook(nbPath, cells, new Set(['g']), base, { fresh: true });
    expect(plan.mode).toBe('link');
    expect(plan.names).toEqual(['g']);
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
