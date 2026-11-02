// The kernel's side of linked files, over its real JSON protocol, in private
// folders (Pyx's data folder and an empty Jupyter runtime folder: no Jupyter
// kernel of the machine is seen):
//   - a function of a linked file brings what it uses (helpers, modules,
//     dictionaries) into the FILE's namespace, not the document's;
//   - \py{x #@s1} reads the x the nearest file or cell above it gave;
//   - \py{df} typesets a pandas table.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const KERNEL = join(process.cwd(), 'src-tauri', 'python', 'kernel.py');
const python = ['python', 'python3', 'py'].find((exe) => spawnSync(exe, ['-c', 'pass']).status === 0);
const hasPandas = !!python && spawnSync(python, ['-c', 'import pandas']).status === 0;

describe.skipIf(!python)('archivos vinculados: dependencias, ámbitos y tablas', { timeout: 60000 }, () => {
  let proc;
  let buf = '';
  let base;
  const waiting = new Map();
  let nextId = 1;

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'pyx-scopes-'));
    for (const d of ['runtime', 'local']) mkdirSync(join(base, d));
    const env = {
      ...process.env, JUPYTER_RUNTIME_DIR: join(base, 'runtime'), LOCALAPPDATA: join(base, 'local'),
      XDG_DATA_HOME: join(base, 'local'), HOME: base, MPLBACKEND: 'Agg',
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
    waiting.set(id, (f) => { clearTimeout(timer); resolve(f); });
    proc.stdin.write(`${JSON.stringify({ id, cwd: base, ...req })}\n`);
  });
  const evals = async (list, scopes) => (await send({ evals: list, scopes })).evals;

  it('una función guardada se lleva lo que usa, sin meterlo en el documento', async () => {
    const nb = join(base, 'oleaje.py');
    await send({
      code: [
        'import math',
        'tabla_hs = {"NW": [1.2, 2.5, 3.1]}',
        'def posicion(i, n):',
        '    return (i - 0.44) / (n + 0.12)',
        'def filas(r):',
        '    hs = sorted(tabla_hs[r])',
        '    return " ".join("%d:%.3f:%.3f" % (i, posicion(i, len(hs)), math.log(h)) for i, h in enumerate(hs, 1))',
      ].join('\n'),
      reset: true,
    });
    const s = await send({ nblink: 'save', notebook: nb, names: ['filas'], codeHash: 'c1', reads: [] });
    expect(s.saved).toEqual(['filas']);
    await send({ code: 'pass', reset: true }); // a new session
    const r = await send({ nblink: 'fetch', notebook: nb, names: ['filas'], codeHash: 'c1' });
    expect(r.source).toBe('snapshot');
    expect(r.deps.sort()).toEqual(['math', 'posicion', 'tabla_hs']);
    const a = await send({ nblink: 'apply', notebook: nb, names: ['filas'], key: 'oleaje.py::valores' });
    expect(a.errors).toEqual({});
    const v = await evals(['filas("NW")', 'posicion']);
    expect(v['filas("NW")']).toEqual({ ok: true, value: '1:0.179:0.182 2:0.500:0.916 3:0.821:1.131' });
    expect(v.posicion.ok).toBe(false); // the helper stays in the file's namespace
  });

  it('una función sin código recuperable se toma del código del cuaderno', async () => {
    const nb = join(base, 'sin-fuente.ipynb');
    const cell = 'k = 10\ndef f(x):\n    return x + k';
    // Defined through exec: Python cannot give its source (no file, no cell).
    await send({ code: `exec(${JSON.stringify(cell)}, globals())`, reset: true });
    const s = await send({ nblink: 'save', notebook: nb, names: ['f'], codeHash: 'c1', reads: [], cells: [cell] });
    expect(s.saved).toEqual(['f']);
    await send({ code: 'pass', reset: true });
    await send({ nblink: 'fetch', notebook: nb, names: ['f'], codeHash: 'c1' });
    await send({ nblink: 'apply', notebook: nb, names: ['f'], key: 'sin-fuente::valores' });
    expect((await evals(['f(5)']))['f(5)'].value).toBe('15');
  });

  it('cualquier función del cuaderno viaja: closures, lambdas en diccionarios, alias, dataclasses', async () => {
    const nb = join(base, 'funciones.ipynb');
    const cells = [
      'from dataclasses import dataclass\nk = 3\ndef hacer(m):\n    return lambda x: x * m + k\ndoble = hacer(2)\nops = {"cuad": lambda x: x ** 2}\ndef pos(i, n):\n    return i / (n + 1)\nalias = pos\n@dataclass\nclass P:\n    x: float\n    y: float\np = P(1.5, 2.5)',
    ];
    await send({ code: cells[0], reset: true });
    const names = ['doble', 'ops', 'alias', 'p'];
    const s = await send({ nblink: 'save', notebook: nb, names, codeHash: 'c1', reads: [], cells });
    expect(s.errors).toEqual({});
    await send({ code: 'pass', reset: true });
    await send({ nblink: 'fetch', notebook: nb, names, codeHash: 'c1' });
    const a = await send({ nblink: 'apply', notebook: nb, names, key: 'funciones::valores' });
    expect(a.errors).toEqual({});
    const v = await evals(['doble(5)', 'ops["cuad"](4)', 'alias(1, 3)', 'p.x + p.y']);
    expect(Object.values(v).map((x) => x.value)).toEqual(['13', '16', '0.25', '4']);
  });

  it('las ayudas de Pyx sirven en \\py{} sin importarlas, y un resultado enorme avisa en vez de romper LaTeX', async () => {
    await send({ code: 'rumbo = "SSW_202.5"\nfilas = "\\n".join("%d & %d \\\\\\\\" % (i, i) for i in range(6000))', reset: true });
    const v = await evals(['texesc(rumbo)', 'filas', '"%.2f" % 2.5']);
    expect(v['texesc(rumbo)'].value).toBe('SSW\\_202.5');
    expect(v.filas.ok).toBe(false);
    expect(v.filas.value).toMatch(/LaTeX no puede componer tanto/);
    expect(v['"%.2f" % 2.5'].value).toBe('2.50');
  });

  it('tras editar el cuaderno se recupera todo lo de la última ejecución (solo se ejecuta lo cambiado)', async () => {
    const nb = join(base, 'calculo.ipynb');
    const cells = ['import math\nL = 12.0', 'def area(b):\n    return b * L', 'A = area(3)'];
    await send({ code: cells.join('\n'), reset: true });
    const ledger = cells.map((c, i) => ({ key: `k${i}`, hash: `h${i}`, defs: [['math', 'L'], ['area'], ['A']][i], reads: [] }));
    const names = ['math', 'L', 'area', 'A'];
    const s = await send({ nblink: 'save', notebook: nb, names, codeHash: 'c1', reads: [], cells, ledger });
    expect(s.errors).toEqual({});
    // Only A changed: the rest is reused, not pickled again.
    await send({ code: 'A = area(5)' });
    const s2 = await send({ nblink: 'save', notebook: nb, names, codeHash: 'c2', reads: [], cells, ledger, fresh: ['A'] });
    expect(s2.saved.sort()).toEqual(['A', 'L', 'area', 'math']);
    await send({ code: 'pass', reset: true }); // a new session, code edited again
    const r = await send({ nblink: 'restore', notebook: nb });
    expect(r.ok).toBe(true);
    expect(r.ledger.map((c) => c.key)).toEqual(['k0', 'k1', 'k2']);
    expect(r.loaded.sort()).toEqual(['A', 'L', 'area', 'math']);
    const v = await evals(['A', 'area(1)', 'math.sqrt(4)']);
    expect(Object.values(v).map((x) => x.value)).toEqual(['60', '12', '2']);
  });

  it('\\py{x} lee el valor del archivo o celda más próximo por encima', async () => {
    await send({ code: 'Hs = 1.5', reset: true });
    await send({ nblink: 'capture', key: 'datos.py::valores', names: ['Hs'] });
    await send({ code: 'Hs = 4.0' });
    const v = await evals(['Hs #@s1', 'Hs', 'round(Hs * 2, 1) #@s1', 'Hs #@s9'], { s1: { Hs: 'datos.py::valores' } });
    expect(v['Hs #@s1'].value).toBe('1.5');
    expect(v['round(Hs * 2, 1) #@s1'].value).toBe('3');
    expect(v.Hs.value).toBe('4');
    expect(v['Hs #@s9'].value).toBe('4'); // an unknown mark: the final value
    // A reset forgets the copies: they belonged to that session.
    await send({ code: 'Hs = 7', reset: true });
    expect((await evals(['Hs #@s1'], { s1: { Hs: 'datos.py::valores' } }))['Hs #@s1'].value).toBe('7');
  });

  it.skipIf(!hasPandas)('\\py{df} es una tabla LaTeX', async () => {
    await send({ code: 'import pandas as pd\ndf = pd.DataFrame({"Rumbo": ["NW", "N"], "Hs (m)": [2.5, float("nan")]})\ns = pd.Series([1, 2], index=["a", "b"], name="n")', reset: true });
    const v = await evals(['df', 's', 'pd.DataFrame({"x": range(600)})']);
    expect(v.df.value).toBe([
      '\\begin{tabular}{lr}', '\\hline', 'Rumbo & Hs (m) \\\\', '\\hline',
      'NW & 2.5 \\\\', 'N &  \\\\', '\\hline', '\\end{tabular}',
    ].join('\n'));
    expect(v.s.value).toContain('a & 1 \\\\');
    expect(v['pd.DataFrame({"x": range(600)})'].ok).toBe(false);
    expect(v['pd.DataFrame({"x": range(600)})'].value).toMatch(/600 filas/);
  });
});
