// @vitest-environment jsdom
// END TO END, FOR REAL: Pyx's own compiler (js/compile/compiler.js, unchanged)
// with the real Python kernel (src-tauri/python/kernel.py) and a real TeX
// engine. Only the desktop shell is replaced: what the Rust side does for the
// compiler — read and write files, start the kernel, run the engine — is done
// here with Node, the same way.
//
// It compiles a whole project folder and checks it ends in a PDF with no
// error. It is how the example projects of the web site are built and
// checked, and the closest thing to opening them in the app.
//
// Skipped unless asked for (it needs Python with the libraries the project
// uses and a TeX distribution):
//   PYX_E2E_ROOT=/ruta/al/_Preámbulo.pltx PYX_E2E_OUT=/ruta/salida.pdf \
//     npx vitest run test/e2e/real-compile.test.js
// (PYX_E2E_REPEAT=2 compiles twice more in the same session and prints the timings.)
import { describe, it, expect, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.PYX_E2E_ROOT || '';
const OUT = process.env.PYX_E2E_OUT || '';
const KERNEL = path.resolve(__dirname, '../../src-tauri/python/kernel.py');
const ENGINE = process.env.PYX_E2E_ENGINE || 'xelatex';
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'pyx-e2e-'));

/* ---------- the parts of the Rust side the compiler uses ---------- */

const py = (code, ...args) => {
  const r = spawnSync('python3', ['-I', '-c', code, ...args], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout;
};
// A .pltx is a zip (manifest.json, source.tex, outputs.json); an old one may
// be plain text. Read the way pltx.rs does.
function pltxRead(p) {
  const out = JSON.parse(py(`
import json, sys, zipfile
p = sys.argv[1]
if zipfile.is_zipfile(p):
    z = zipfile.ZipFile(p)
    n = z.namelist()
    print(json.dumps({"is_zip": True, "source": z.read("source.tex").decode("utf-8") if "source.tex" in n else None,
                      "outputs": z.read("outputs.json").decode("utf-8") if "outputs.json" in n else None}))
else:
    print(json.dumps({"is_zip": False, "source": None, "outputs": None}))
`, p));
  return out;
}
async function sourceOf(p) {
  if (/\.pltx$/i.test(p)) {
    const r = pltxRead(p);
    if (r.is_zip) return r.source;
  }
  return fsp.readFile(p, 'utf8');
}

// The kernel: one process, newline-delimited JSON, answers matched by id.
let kproc = null;
const waiting = new Map();
function kernelUp() {
  if (kproc) return;
  kproc = spawn('python3', ['-u', KERNEL], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, MPLBACKEND: 'Agg', PYTHONIOENCODING: 'utf-8' } });
  let buf = '';
  kproc.stdout.setEncoding('utf8');
  kproc.stdout.on('data', (c) => {
    buf += c;
    for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let f;
      try { f = JSON.parse(line); } catch (_) { continue; }
      const w = waiting.get(f.id);
      if (w) { waiting.delete(f.id); w(f); }
    }
  });
  kproc.stderr.on('data', (c) => { if (process.env.PYX_E2E_DEBUG) process.stderr.write(c); });
}
function kernelExec(req) {
  kernelUp();
  return new Promise((resolve) => {
    waiting.set(req.id, resolve);
    kproc.stdin.write(`${JSON.stringify(req)}\n`);
  });
}
function kernelRestart() {
  if (kproc) { try { kproc.kill(); } catch (_) { /* gone */ } }
  kproc = null;
  waiting.clear();
  kernelUp();
  return { python: '3' };
}

// The engine, the way latex.rs runs it: in the project folder, output in the
// working directory, TEXINPUTS = working dir + the project's folders.
const engineRuns = [];
async function compileLatex(file, projectDir, engine, passes, jobname, searchDirs = []) {
  const outDir = path.dirname(file);
  const job = jobname || path.basename(file).replace(/\.tex$/, '');
  const env = { ...process.env, TEXINPUTS: ['.', outDir, ...searchDirs, ''].join(':') };
  let log = '';
  const t0 = Date.now();
  for (let pass = 1; pass <= Math.max(passes, 3); pass++) {
    const r = spawnSync(ENGINE, ['-interaction=nonstopmode', '-synctex=1', `-output-directory=${outDir}`, `-jobname=${job}`, file],
      { cwd: projectDir, env, encoding: 'utf8', maxBuffer: 64 << 20 });
    log += `===== Pasada ${pass} (${ENGINE}) =====\n${r.stdout}\n`;
    engineRuns.push({ file, pass, status: r.status });
    if (pass >= passes && !/Rerun to get|Label\(s\) may have changed|There were undefined references/.test(r.stdout)) break;
  }
  const pdf = path.join(outDir, `${job}.pdf`);
  const ok = fs.existsSync(pdf) && !/^! /m.test(log);
  const st = fs.existsSync(pdf) ? fs.statSync(pdf) : null;
  return {
    ok, pdf_path: st ? pdf : null, log, engine, stopped: null, inputs: [], started_ms: t0, gen: 0,
    outcome: st ? 'pdf' : 'sin-pdf', reason: st ? '' : 'El motor no escribió ningún PDF.',
    pdf: st ? { path: pdf, size: st.size, mtime: st.mtimeMs } : null,
    timings: { wait_ms: 0, prep_ms: 0, passes_ms: [Date.now() - t0], tools_ms: 0, finish_ms: 0, total_ms: Date.now() - t0, warm: false },
  };
}

vi.mock('../../js/core/platform.js', async (orig) => ({
  ...(await orig()),
  isTauri: () => true,
  invoke: async (cmd) => { throw new Error(`orden no simulada: ${cmd}`); },
  writeTextFile: async (p, c) => { await fsp.mkdir(path.dirname(p), { recursive: true }); await fsp.writeFile(p, c); },
  readTextFile: async (p) => fsp.readFile(p, 'utf8'),
  readBinaryFile: async (p) => new Uint8Array(await fsp.readFile(p)),
  readDir: async (p) => (await fsp.readdir(p, { withFileTypes: true }))
    .map((e) => ({ name: e.name, path: path.join(p, e.name), is_dir: e.isDirectory() })),
  pathExists: async (p) => fs.existsSync(p),
  fileStamps: async (ps) => ps.map((p) => { try { const s = fs.statSync(p); return { mtime: Math.floor(s.mtimeMs), size: s.size }; } catch (_) { return { mtime: -1, size: -1 }; } }),
  buildDirFor: async (p) => { const d = path.join(WORK, path.basename(p).replace(/\W+/g, '_')); await fsp.mkdir(d, { recursive: true }); return d; },
  createDir: async (p) => { await fsp.mkdir(p, { recursive: true }); },
  readSources: async (ps) => Promise.all(ps.map((p) => sourceOf(p).catch(() => null))),
  pltxRead: async (p) => pltxRead(p),
  readNotebook: async (p) => JSON.parse(await fsp.readFile(p, 'utf8')).cells
    .filter((c) => c.cell_type === 'code')
    .map((c) => ({ id: c.id || null, source: Array.isArray(c.source) ? c.source.join('') : String(c.source || '') })),
  emitToWindow: () => {},
  compileCancel: async () => true,
  compileLatex,
  kernelStart: async () => { kernelUp(); return { python: '3' }; },
  kernelSetPython: async () => kernelRestart(),
  kernelReset: async () => kernelRestart(),
  kernelInterrupt: async () => {},
  kernelExec,
  messageDialog: async () => {},
  // \celda: the Rust reader (sheets.rs) is not here; the same values, read
  // with Python's csv / openpyxl.
  sheetValues: async (file, sheet, refs) => JSON.parse(py(`
import csv, json, re, sys
path, sheet, refs = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
def num(t, comma):
    t = t.strip()
    if not t: return None
    s = t.replace(".", "").replace(",", ".") if comma and "," in t else t
    try: return float(s)
    except ValueError: return t
if path.lower().endswith((".csv", ".txt")):
    raw = open(path, encoding="utf-8-sig").read()
    d = ";" if raw.count(";") >= raw.count(",") else ","
    g = {(r, c): num(v, d != ",") for r, row in enumerate(csv.reader(raw.splitlines(), delimiter=d), 1) for c, v in enumerate(row, 1)}
else:
    import openpyxl
    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb[sheet] if sheet else wb.worksheets[0]
    g = {(c.row, c.column): c.value for row in ws.iter_rows() for c in row if c.value is not None}
def pos(a):
    m = re.fullmatch(r"([A-Za-z]+)(\\d+)", a.strip().replace("$", ""))
    col = 0
    for ch in m.group(1).upper(): col = col * 26 + ord(ch) - 64
    return int(m.group(2)), col
out = []
for r in refs:
    try:
        a, _, b = r.partition(":")
        (r1, c1), (r2, c2) = pos(a), pos(b or a)
        out.append({"ok": True, "error": "", "grid": [[g.get((i, j)) for j in range(c1, c2 + 1)] for i in range(r1, r2 + 1)]})
    except Exception as e:
        out.append({"ok": False, "error": str(e), "grid": []})
print(json.dumps(out))
`, file, sheet || '', JSON.stringify(refs))),
}));
let rootText = '';
vi.mock('../../js/editor/setup.js', async (orig) => ({
  ...(await orig()),
  getDocContent: () => rootText,
  getViewOfDoc: () => null,
}));
vi.mock('../../js/editor/py-ghost.js', () => ({ setScopedValues: () => {}, refreshGhostIn: () => {} }));
const shown = [];
vi.mock('../../js/pdf/preview.js', () => ({
  getPdfPath: () => shown.at(-1) || null,
  loadPdf: async (p) => { shown.push(p); return { readMs: 1, parseMs: 1, painted: Promise.resolve(1) }; },
}));
vi.mock('../../js/solid/stores/previewStore.js', () => ({ auxOpen: () => false, lastArea: () => 'editor' }));
vi.mock('../../js/solid/stores/docStore.js', () => ({
  saveActiveAs: async () => false,
  saveWithEncoding: async () => {},
  markSavedIfUnchanged: () => true,
}));
vi.mock('../../js/compile/build-maps.js', async (orig) => ({
  ...(await orig()), persistBuildMaps: async () => {}, ensureBuildMaps: async () => false,
}));

describe.skipIf(!ROOT)('compilación real de un proyecto', () => {
  it(`compila ${path.basename(ROOT)} sin errores`, async () => {
    const { state } = await import('../../js/core/state.js');
    const { general } = await import('../../js/solid/stores/settingsStore.js');
    Object.assign(general, { warmEngine: false, liveDelay: 0, cellTimeout: 0, pdfFollowCursor: false, pythonPath: '' });
    const compiler = await import('../../js/compile/compiler.js');
    rootText = await sourceOf(ROOT);
    state.documents = [{ id: 1, fileName: path.basename(ROOT), path: ROOT, modified: false, engine: ENGINE }];
    state.activeIndex = 0;
    state.panes = [{ id: 1, docId: 1 }];
    state.activePaneId = 1;
    state.liveCompile = false;
    // PYX_E2E_REPEAT=n compiles n more times in the same session (kernel and
    // engine kept), like pressing «Compilar y ver» again in the app: that is
    // the compile a person waits for, and its timings go to the log.
    const settle = async () => { for (let i = 0; i < 2400 && (state.compiling || state.compileQueued || state.pdfLoading); i++) await new Promise((r) => setTimeout(r, 50)); };
    await compiler.compileActive(true, { force: true, fresh: true });
    await settle();
    for (let k = 0; k < (+process.env.PYX_E2E_REPEAT || 0); k++) {
      await compiler.compileActive(true, { force: true });
      await settle();
      const tm = String(state.lastLog || '').match(/===== Tiempos de Pyx =====[\s\S]*?Total[^\n]*/);
      if (tm) console.log(`--- compilación ${k + 2} ---\n${tm[0]}`);
    }
    const log = String(state.lastLog || '');
    fs.writeFileSync(`${OUT || path.join(WORK, 'out.pdf')}.log`, log);
    if (process.env.PYX_E2E_DEBUG) console.log(log.slice(0, 6000));
    const warnings = (log.match(/===== Avisos de Pyx =====[\s\S]*?\n\n/) || [''])[0];
    expect(warnings, warnings).toBe('');
    expect(state.lastCompileOk, log.slice(-3000)).toBe(true);
    expect(shown.length).toBeGreaterThan(0);
    const pdf = shown.at(-1);
    if (OUT) fs.copyFileSync(pdf, OUT);
    if (kproc) kproc.kill();
  }, 600000);
});
