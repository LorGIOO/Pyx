// \pynotebook: the notebook's VALUES, never its code, over the real kernel.
//
// Drives kernel.py over its stdin/stdout JSON protocol, as the app does, in
// PRIVATE folders: its own Pyx data folder (where the snapshots live) and its
// own, empty Jupyter runtime folder — so no Jupyter kernel of the machine is
// ever seen or touched. With no Jupyter, the values come from the snapshot of
// Pyx's own last run, valid while the notebook's code and data are the same.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const KERNEL = fileURLToPath(new URL('../src-tauri/python/kernel.py', import.meta.url));

const python = ['python', 'python3', 'py'].find((exe) => spawnSync(exe, ['-c', 'pass']).status === 0);

describe.skipIf(!python)('\\pynotebook: los valores del cuaderno, sin ejecutarlo', { timeout: 60000 }, () => {
  let proc;
  let buf = '';
  let base;
  let nb;
  let data;
  const waiting = new Map();
  let nextId = 1;

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'pyx-nblink-'));
    const runtime = join(base, 'runtime');
    const local = join(base, 'local');
    mkdirSync(runtime);
    mkdirSync(local);
    nb = join(base, 'calculos.ipynb');
    data = join(base, 'caudales.csv');
    writeFileSync(data, 'q\n1\n2\n');
    const env = {
      ...process.env,
      JUPYTER_RUNTIME_DIR: runtime, // empty: no Jupyter kernel to find
      LOCALAPPDATA: local, // Windows: Pyx's data folder
      XDG_DATA_HOME: local, // Linux
      HOME: base, // macOS (~/Library/Application Support/Pyx)
      MPLBACKEND: 'Agg',
    };
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
  });

  afterAll(() => {
    try { proc.stdin.end(); proc.kill(); } catch (_) { /* gone */ }
    try { rmSync(base, { recursive: true, force: true }); } catch (_) { /* in use */ }
  });

  const send = (req) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error('kernel did not answer')), 60000);
    waiting.set(id, (frame) => { clearTimeout(timer); resolve(frame); });
    proc.stdin.write(`${JSON.stringify({ id, cwd: base, ...req })}\n`);
  });
  const value = async (expr) => (await send({ evals: [expr] })).evals[expr].value;

  it('sin Jupyter ni valores guardados: hay que ejecutarlo, y lo dice', async () => {
    const r = await send({ nblink: 'fetch', notebook: nb, names: ['Q'], codeHash: 'c1' });
    expect(r.source).toBe(null);
    expect(r.reason).toMatch(/no hay valores guardados/);
  });

  it('tras ejecutarlo en Pyx, sus valores se guardan y se cargan sin ejecutar nada', async () => {
    // What running the notebook's cells left in the namespace.
    await send({ code: 'import math\nQ = 12.5\ndef factor(x):\n    return x * 2\ncontador = 0', reset: true });
    const s = await send({
      nblink: 'save', notebook: nb, names: ['Q', 'factor', 'math'], extra: ['contador'], codeHash: 'c1',
      reads: [],
    });
    expect(s.saved).toEqual(['Q', 'contador', 'factor', 'math']);
    // A new session: an empty namespace.
    await send({ code: 'pass', reset: true });
    const r = await send({ nblink: 'fetch', notebook: nb, names: ['Q', 'factor', 'math'], codeHash: 'c1' });
    expect(r.source).toBe('snapshot');
    expect(r.from).toBe('pyx');
    const a = await send({ nblink: 'apply', notebook: nb, names: Object.keys(r.names) });
    expect(a.ok).toBe(true);
    expect(await value('factor(Q) + math.floor(1.5)')).toBe('26');
    // The small "extra" values were kept: a \py{} added later is served too.
    const later = await send({ nblink: 'fetch', notebook: nb, names: ['contador'], codeHash: 'c1' });
    expect(later.source).toBe('snapshot');
  });

  it('aplicar de nuevo los mismos valores los marca como sin cambios', async () => {
    const r = await send({ nblink: 'fetch', notebook: nb, names: ['Q'], codeHash: 'c1' });
    const a = await send({ nblink: 'apply', notebook: nb, names: Object.keys(r.names) });
    expect(a.unchanged).toContain('Q');
  });

  it('un cambio en el código del cuaderno invalida los valores guardados', async () => {
    const r = await send({ nblink: 'fetch', notebook: nb, names: ['Q'], codeHash: 'c2' });
    expect(r.source).toBe(null);
    expect(r.reason).toMatch(/código ha cambiado/);
  });

  it('un cambio en los datos que leyó también', async () => {
    await send({ code: 'Q = 3.0', reset: true });
    const stamp = (await send({ code: `import os\nst = os.stat(${JSON.stringify(data)})\nms = st.st_mtime_ns // 1000000\nsz = st.st_size` }));
    expect(stamp.ok).toBe(true);
    const ms = Number(await value('ms'));
    const sz = Number(await value('sz'));
    await send({ nblink: 'save', notebook: nb, names: ['Q'], codeHash: 'c3', reads: [[data, ms, sz]] });
    expect((await send({ nblink: 'fetch', notebook: nb, names: ['Q'], codeHash: 'c3' })).source).toBe('snapshot');
    writeFileSync(data, 'q\n1\n2\n3\n');
    const r = await send({ nblink: 'fetch', notebook: nb, names: ['Q'], codeHash: 'c3' });
    expect(r.source).toBe(null);
    expect(r.reason).toMatch(/han cambiado los datos que lee \(caudales\.csv\)/);
  });

  it('la respuesta dice de qué archivos depende y si se puede recordar', async () => {
    // What lets Pyx answer the next compile without asking (cell-runner.js
    // fetchLink): the files whose change would change the answer.
    await send({ code: 'Q = 4.0', reset: true });
    await send({ code: `import os\nst = os.stat(${JSON.stringify(data)})\nms = st.st_mtime_ns // 1000000\nsz = st.st_size` });
    const ms = Number(await value('ms'));
    const sz = Number(await value('sz'));
    await send({ nblink: 'save', notebook: nb, names: ['Q'], codeHash: 'c4', reads: [[data, ms, sz]] });
    const r = await send({ nblink: 'fetch', notebook: nb, names: ['Q'], codeHash: 'c4' });
    expect(r.source).toBe('snapshot');
    expect(r.cacheable).toBe(true); // no Jupyter: nothing changes without a file changing
    const tail = (p) => p.replace(/\\/g, '/').split('/').pop();
    expect(tail(r.watch[0])).toBe('meta.json'); // the saved values themselves
    expect(r.watch.map(tail)).toContain('caudales.csv'); // and the data they came from
    // A "no" is remembered too, while the same files stay as they are.
    const no = await send({ nblink: 'fetch', notebook: nb, names: ['Q'], codeHash: 'otro' });
    expect(no.source).toBe(null);
    expect(no.cacheable).toBe(true);
    expect(tail(no.watch[0])).toBe('meta.json');
  });

  it('una función de un archivo vinculado lee sus rutas relativas desde SU carpeta, la llame quien la llame', async () => {
    // The notebook lives in hidro/ and reads "nivel.csv" next to it; the
    // document is in the folder above.
    const sub = join(base, 'hidro');
    mkdirSync(sub);
    writeFileSync(join(sub, 'nivel.csv'), '7\n');
    const nb2 = join(sub, 'hidro.ipynb');
    // Its cells run in its folder (as the app does: runCwd)…
    const def = await send({
      code: 'veces = [0]\ndef cargar():\n    veces[0] += 1\n    return open("nivel.csv").read().strip()',
      cwd: sub, reset: true,
    });
    expect(def.ok).toBe(true);
    // …and a cell of the DOCUMENT calls the function from the document's folder.
    const call = await send({ code: 'nivel = cargar()' });
    expect(call.ok).toBe(true);
    expect(await value('nivel')).toBe('7');
    // The file is among what the cell read: a change to it re-runs the cell.
    expect(call.reads.map((r) => r[0].replace(/\\/g, '/').split('/').pop())).toContain('nivel.csv');
    // A \py{} too, and without evaluating the expression twice.
    expect(await value('cargar()')).toBe('7');
    expect(await value('veces[0]')).toBe('2');
    // A file of the working folder always wins; one that is nowhere still fails.
    writeFileSync(join(base, 'nivel.csv'), '9\n');
    expect(await value('cargar()')).toBe('9');
    rmSync(join(base, 'nivel.csv'));
    const missing = await send({ code: 'open("no-existe.csv")' });
    expect(missing.ok).toBe(false);
    expect(JSON.stringify(missing.error)).toMatch(/FileNotFoundError/);

    // The same with the values LINKED (nothing of the notebook ran here).
    const s = await send({ nblink: 'save', notebook: nb2, names: ['cargar', 'veces'], codeHash: 'h1', reads: [] });
    expect(s.saved).toContain('cargar');
    await send({ code: 'pass', reset: true });
    const r = await send({ nblink: 'fetch', notebook: nb2, names: ['cargar'], codeHash: 'h1' });
    expect(r.source).toBe('snapshot');
    expect((await send({ nblink: 'apply', notebook: nb2, names: Object.keys(r.names) })).ok).toBe(true);
    const linked = await send({ code: 'nivel2 = cargar()' });
    expect(linked.ok).toBe(true);
    expect(await value('nivel2')).toBe('7');
  });

  it('todo queda en la carpeta privada de la prueba', () => {
    const dir = process.platform === 'win32' ? join(base, 'local', 'Pyx', 'jupyter')
      : process.platform === 'darwin' ? join(base, 'Library', 'Application Support', 'Pyx', 'jupyter')
        : join(base, 'local', 'pyx', 'jupyter');
    expect(readdirSync(dir).length).toBeGreaterThan(0);
  });
});
