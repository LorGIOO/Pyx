// pyx.datos(): cells of an Excel workbook or a CSV, by their Excel address,
// over the kernel's real JSON protocol: one cell, a column, a row, a table,
// another sheet, .T to transpose, sheet text escaped for LaTeX, and the file
// read again when it changes.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const KERNEL = join(process.cwd(), 'src-tauri', 'python', 'kernel.py');
const python = ['python', 'python3', 'py'].find((exe) => spawnSync(exe, ['-c', 'pass']).status === 0);
const hasPandas = !!python && spawnSync(python, ['-c', 'import pandas']).status === 0;

const hasOpenpyxl = !!python && spawnSync(python, ['-c', 'import openpyxl']).status === 0;
describe.skipIf(!python)('datos(): celdas de Excel y CSV', { timeout: 60000 }, () => {
  let proc;
  let buf = '';
  let base;
  const waiting = new Map();
  let nextId = 1;

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'pyx-datos-'));
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


  it('lee una celda, una columna, una fila y una tabla de un CSV con ; y coma decimal', async () => {
    writeFileSync(join(base, 'cargas.csv'), 'carga;valor;unidad\nPeso propio;0,49;kN/m\nTablero;1,10;kN/m\nI+D & Co;3;kN\n');
    await send({ code: 'from pyx import datos\nc = datos("cargas.csv", "B2:B4")\nt = sum(c)', reset: true });
    const v = await evals(['datos("cargas.csv", "B2")', 'datos("cargas.csv", "A1")', 'c', 'c.T', 'datos("cargas.csv", "A2:B3")', 't', 'datos("cargas.csv", "A4")']);
    expect(v['datos("cargas.csv", "B2")'].value).toBe('0.49');
    expect(v['datos("cargas.csv", "A1")'].value).toBe('carga');
    expect(v.c.value).toBe('0.49 \\\\\n1.1 \\\\\n3 \\\\');
    expect(v['c.T'].value).toBe('0.49 & 1.1 & 3');
    expect(v['datos("cargas.csv", "A2:B3")'].value).toBe('Peso propio & 0.49 \\\\\nTablero & 1.1 \\\\');
    expect(v.t.value).toBe('4.59');
    expect(v['datos("cargas.csv", "A4")'].value).toBe('I+D \\& Co'); // texto de la hoja, escapado
  });

  it('vuelve a leer el archivo cuando cambia', async () => {
    writeFileSync(join(base, 'v.csv'), 'a,1\n');
    expect((await evals(['datos("v.csv", "B1")']))['datos("v.csv", "B1")'].value).toBe('1');
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(join(base, 'v.csv'), 'a,25\n');
    expect((await evals(['datos("v.csv", "B1")']))['datos("v.csv", "B1")'].value).toBe('25');
  });

  it.skipIf(!hasOpenpyxl)('lee un .xlsx, con hojas y transposición', async () => {
    await send({ code: [
      'import openpyxl',
      'wb = openpyxl.Workbook(); ws = wb.active; ws.title = "Datos"',
      'ws["E4"] = 12.5; ws["E5"] = 7; ws["F4"] = "S275"',
      'h = wb.create_sheet("Cargas"); h["B2"] = 3.75',
      'wb.save("libro.xlsx")',
      'from pyx import datos',
      'libro = datos("libro.xlsx")',
    ].join('\n'), reset: true });
    const v = await evals(['datos("libro.xlsx", "E4")', 'libro["E4:E5"].T', 'libro["Cargas!B2"]', 'datos("libro.xlsx", "B2", hoja="Cargas")', 'libro.hojas', 'libro["E4:F4"]']);
    expect(v['datos("libro.xlsx", "E4")'].value).toBe('12.5');
    expect(v['libro["E4:E5"].T'].value).toBe('12.5 & 7');
    expect(v['libro["Cargas!B2"]'].value).toBe('3.75');
    expect(v['datos("libro.xlsx", "B2", hoja="Cargas")'].value).toBe('3.75');
    expect(v['libro["E4:F4"]'].value).toBe('12.5 & S275');
    const bad = await evals(['libro["Nada!A1"]']);
    expect(bad['libro["Nada!A1"]'].ok).toBe(false);
  });
});
