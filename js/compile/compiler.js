// Compile orchestration: save → run cells → resolve \py{...} → write a build
// copy with values substituted → run the engine → load the PDF. Single action.

import { state, activeDoc } from '../core/state.js';
import { getDocContent, getViewOfDoc } from '../editor/setup.js';
import {
  writeTextFile, readTextFile, readDir, pathExists, compileLatex, emitToWindow,
  pltxRead,
} from '../core/platform.js';
import { parseCellsText, execCellByCode } from '../editor/cells.js';
import { runCellCode, evalExpressions, withKernelLock } from '../editor/cell-runner.js';
import {
  findPyExprs, resolvePyText, neutralizeCells, dirOf, joinPath, stemOf, baseName, BUILD_SUFFIX,
  findPyIfExprs, resolvePyIf, collectPyIfConds, pyifKey, createVerbatimTracker,
} from './latex-bridge.js';
import { loadPdf } from '../pdf/preview.js';
import { auxOpen } from '../solid/stores/previewStore.js';
import { saveActiveAs } from '../solid/stores/docStore.js';
import { general } from '../solid/stores/settingsStore.js';

/* ---- live compile (TeXstudio-style) ----
   The editor schedules a background compile shortly after typing stops; the
   heavy work (xelatex, Python) runs OFF the UI thread (async Tauri commands),
   so writing never blocks. Unsaved documents are skipped — a save dialog must
   never pop up mid-keystroke. */
let liveTimer = null;
export function scheduleLiveCompile() {
  if (!state.liveCompile) return;
  const doc = activeDoc();
  if (!doc || doc.kind || !doc.path) return;
  clearTimeout(liveTimer);
  liveTimer = setTimeout(() => {
    if (state.compiling) { scheduleLiveCompile(); return; } // trail the current run
    const d = activeDoc();
    if (!d || d.kind || !d.path) return;
    // Python-only documents (cells, no LaTeX, no master) run cells ON DEMAND:
    // auto-running them on every typing pause could re-trigger long
    // computations. CHILD files of a master (text fragments) DO live compile —
    // compileActive resolves and builds their root document.
    const c = getDocContent(d.id);
    const isPyx = !(d.fileName || '').toLowerCase().endsWith('.tex') || parseCellsText(c).length > 0;
    if (isPyx
      && !/\\documentclass|\\begin\s*\{document\}/.test(c)
      && !/^\s*%\s*!TEX\s+root/im.test(c)
      && parseCellsText(c).length > 0) return;
    compileActive(false);
  }, Math.max(300, +general.liveDelay || 1100));
}

// Last successfully compiled PDF — reloaded into the in-app pane when the
// auxiliary viewer window closes (all updates went THERE while it was open).
let lastPdfPath = null;
export function reloadLastPdf() {
  if (lastPdfPath) loadPdf(lastPdfPath).catch(() => {});
}

/* Cell-run cache: in BACKGROUND compiles (auto-save / live typing), if no cell
   code changed since the last clean run, the kernel namespace is already
   correct — skip the reset+rerun and let xelatex dominate the wall time.
   Manual "Compilar y ver" always re-runs everything (ground truth). */
let lastCellSig = null;
let lastRenderByFile = new Map(); // path -> renderByCode
let lastCellsFailed = true;

/* ---- master/root documents (TeXstudio-style) ----
   Compiling a CHILD file (a chapter \input'ed by a main) compiles its ROOT:
   `% !TEX root = ../main.tex` wins; otherwise the open documents and then the
   child's folder + parent folder are searched for a \documentclass file that
   \input/\includes it. Cached briefly so live compiles don't rescan disk. */
const rootCache = new Map(); // docId -> { path, at }
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isPltx = (p) => /\.pltx$/i.test(p || ''); // ZIP container — never write raw

// Read a source file from DISK for compiling. A container .pltx must go
// through pltx_read (its zip bytes are not text); legacy/plain files read
// as text. Every disk read in this module uses this — never readTextFile.
async function readSourceFile(path) {
  if (isPltx(path)) {
    try {
      const r = await pltxRead(path);
      if (r && r.is_zip && r.source != null) return r.source;
    } catch (_) { /* fall through to plain read */ }
  }
  return readTextFile(path);
}

async function resolveRootPath(doc, content) {
  if (!doc.path || /\\documentclass/.test(content)) return doc.path;
  const hit = rootCache.get(doc.id);
  if (hit && Date.now() - hit.at < 20000) return hit.path;
  let root = doc.path;
  const dir = dirOf(doc.path);
  const magic = /^\s*%\s*!TEX\s+root\s*=\s*(.+?)\s*$/im.exec(content);
  if (magic) {
    const rel = magic[1].replace(/\//g, '\\');
    const p = /^[a-zA-Z]:[\\/]/.test(magic[1]) ? rel : joinPath(dir, rel);
    if (await pathExists(p)) root = p;
  } else {
    const needle = new RegExp(
      '\\\\(?:input|include)\\s*\\{[^}]*' + escRe(stemOf(doc.path)) + '[^}]*\\}');
    let found = null;
    for (const d of state.documents) {
      if (d.kind || !d.path || d.path === doc.path) continue;
      const c = getDocContent(d.id);
      if (/\\documentclass/.test(c) && needle.test(c)) { found = d.path; break; }
    }
    if (!found) {
      const parent = dirOf(dir);
      for (const scan of parent && parent !== dir ? [dir, parent] : [dir]) {
        let entries = [];
        try { entries = await readDir(scan); } catch (_) {}
        for (const en of entries) {
          if (en.is_dir || !/\.(tex|pltx)$/i.test(en.name) || en.path === doc.path) continue;
          let c = null;
          try { c = await readSourceFile(en.path); } catch (_) { continue; }
          if (/\\documentclass/.test(c) && needle.test(c)) { found = en.path; break; }
        }
        if (found) break;
      }
    }
    if (found) root = found;
  }
  rootCache.set(doc.id, { path: root, at: Date.now() });
  return root;
}

/* ---- multi-file gather / run / build (document order, depth ≤ 3) ---- */
const INPUT_SRC = '\\\\(input|include)\\s*\\{([^}]+)\\}';
const isPyxPath = (p) => !/\.tex$/i.test(p); // per-FILE rule: .tex = pure LaTeX…
// …UNLESS it actually contains Python cells: a .tex with %#python cells is
// processed (cells run, \py{} resolved) just like a .pltx, so cells can be
// dropped into an existing LaTeX file.
const pyxLike = (p, content) => isPyxPath(p) || parseCellsText(content).length > 0;

async function resolveChildPath(rootDir, raw) {
  const rel = raw.trim().replace(/\//g, '\\');
  const base = /^[a-zA-Z]:[\\/]/.test(raw) ? rel : joinPath(rootDir, rel);
  const cands = /\.[a-z0-9]+$/i.test(base) ? [base] : [base + '.tex', base + '.pltx'];
  for (const c of cands) if (await pathExists(c)) return c;
  return null;
}

// path -> { content, raws: Map(rawArg -> childPath), renderByCode }. Saves any
// modified open child to disk on the way (compiling = saving what it uses).
async function gatherTree(rootPath, rootContent, rootDir) {
  const files = new Map();
  const walk = async (path, content, depth) => {
    const f = { content, raws: new Map(), renderByCode: {} };
    files.set(path, f);
    if (depth >= 3) return;
    const re = new RegExp(INPUT_SRC, 'g');
    let m;
    while ((m = re.exec(content))) {
      const child = await resolveChildPath(rootDir, m[2]);
      if (!child) continue;
      f.raws.set(m[2], child);
      if (files.has(child)) continue;
      const open = state.documents.find((d) => d.path === child && !d.kind);
      let c = open ? getDocContent(open.id) : null;
      if (c == null) {
        try { c = await readSourceFile(child); } catch (_) { continue; }
      } else if (open.modified && !isPltx(child)) {
        // .pltx children are ZIP containers (packed on Save) — never overwrite
        // with raw text; the child's .build.tex is what actually compiles.
        await writeTextFile(child, c);
        open.modified = false;
      }
      await walk(child, c, depth + 1);
    }
  };
  await walk(rootPath, rootContent, 0);
  return files;
}

export async function compileActive(showViewer = true) {
  // One compile at a time: a save-triggered auto-compile and a manual compile
  // would otherwise run cells twice and race on the same .build.tex.
  if (state.compiling) return;
  let doc = activeDoc();
  if (!doc) return;

  // A file must exist on disk for the engine (and relative paths) to work.
  if (!doc.path) {
    const ok = await saveActiveAs();
    if (!ok) return;
    doc = activeDoc();
    if (!doc || !doc.path) return;
  }

  state.compiling = true;
  state.lastCompileOk = null;
  // The detached viewer replaces the in-app pane: don't reopen it while the
  // auxiliary window is the one showing the PDF.
  if (showViewer && !auxOpen()) state.previewVisible = true;
  try {
    const content = getDocContent(doc.id);
    // Persist the SOURCE to disk on compile so the engine sees the latest —
    // but a .pltx is a ZIP container (packed only on explicit Save): writing
    // plain text to it would corrupt it, so we compile from the .build.tex and
    // leave the container untouched (stays 'modified' until the user saves).
    if (!isPltx(doc.path)) {
      await writeTextFile(doc.path, content);
      doc.modified = false;
    }

    // 0) Master document: compiling a child compiles its ROOT (and the whole
    //    \input tree below it). The root may be open (use its live content) or
    //    only on disk.
    const rootPath = await resolveRootPath(doc, content);
    let rootDoc = doc;
    let rootContent = content;
    if (rootPath !== doc.path) {
      const open = state.documents.find((d) => d.path === rootPath && !d.kind);
      if (open) {
        rootDoc = open;
        rootContent = getDocContent(open.id);
        if (!isPltx(rootPath)) { await writeTextFile(rootPath, rootContent); open.modified = false; }
      } else {
        rootDoc = { id: -1, path: rootPath, fileName: baseName(rootPath), engine: doc.engine };
        try { rootContent = await readSourceFile(rootPath); } catch (_) { rootContent = ''; }
      }
    }

    const cwd = dirOf(rootPath);
    const stem = stemOf(rootPath);
    let problems = '';
    let cellsFailed = false;
    const cellProblem = (label, stderr, docLine) => {
      cellsFailed = true;
      const last = (stderr || '').split('\n').filter((l) => l.trim()).pop();
      const at = docLine ? ` · línea ${docLine}` : '';
      problems += `\n[${label}${at}] ${last || 'error de ejecución'}`;
    };

    // 1) Gather the \input tree and run every Python cell in DOCUMENT ORDER
    //    (a child's cells run at its \input position). Per-file rule: .tex is
    //    pure LaTeX; only .pltx files get cells and \py{}.
    const isPyx = pyxLike(rootPath, rootContent);
    const pythonOnly = isPyx && !/\\documentclass|\\begin\s*\{document\}/.test(rootContent);
    const files = await gatherTree(rootPath, rootContent, cwd);
    const pyFiles = [...files.keys()].filter((p) => pyxLike(p, files.get(p).content));
    const pyValExprs = pythonOnly ? [] : [
      ...new Set(pyFiles.flatMap((p) => findPyExprs(files.get(p).content).map((e) => e.expr))),
    ];
    // \pyif{cond}{…}{…} conditions are evaluated as bool(cond) alongside \py{}.
    const condExprs = pythonOnly ? [] : [
      ...new Set(pyFiles.flatMap((p) => collectPyIfConds(files.get(p).content))),
    ];
    const exprs = [...pyValExprs, ...condExprs.map(pyifKey)];
    let valueMap = {};
    const SEP = String.fromCharCode(0); // unambiguous cell-boundary separator
    const anyCells = pyFiles.some((p) => parseCellsText(files.get(p).content).length > 0);

    if (anyCells || exprs.length) {
      const sig = pyFiles
        .map((p) => p + ':' + parseCellsText(files.get(p).content).map((c) => c.code).join(SEP))
        .join(SEP);

      const runTree = async () => {
        cellsFailed = false;
        problems = '';
        for (const f of files.values()) f.renderByCode = {};
        await runCellCode('', { cwd, reset: true });
        const ran = new Set();
        const step = async (path) => {
          if (ran.has(path)) return;
          ran.add(path);
          const f = files.get(path);
          if (!f) return;
          const hasCells = pyxLike(path, f.content);
          const od = state.documents.find((d) => d.path === path && !d.kind);
          const view = od ? getViewOfDoc(od.id) : null;
          // Cells inside verbatim environments (minted…) are displayed code —
          // never run them (same rule as parseCells / neutralizeCells).
          const inVerb = createVerbatimTracker();
          let inCell = false, code = [], n = 0, lineNo = 0, headerLn = 0;
          for (const line of f.content.split(/\r?\n/)) {
            lineNo++;
            const verb = inCell ? false : inVerb(line);
            const t = line.trim();
            if (hasCells && !inCell && !verb && t.startsWith('%#python')) { inCell = true; code = []; headerLn = lineNo; continue; }
            if (hasCells && inCell && t.startsWith('%#end')) {
              inCell = false; n++;
              const joined = code.join('\n');
              const res = await execCellByCode(view, joined, cwd);
              if (res && res.ok === false) {
                // Absolute document line of the failure (VSCode-style precision).
                const el = res.error && res.error.line != null ? headerLn + res.error.line : null;
                // The traceback is structured now (colored in the cell): the
                // problem message comes from it, with lines mapped to the doc.
                const emsg = res.error
                  ? `${res.error.type}: ${String(res.error.msg || '').replace(
                      /\b(line|línea)\s+(\d+)/gi, (a, w, m2) => `${w} ${headerLn + +m2}`)}`
                  : res.stderr;
                cellProblem(`${baseName(path)} · celda ${n}`, emsg, el);
              }
              if (res && res.render) f.renderByCode[joined] = res.render;
              continue;
            }
            if (inCell) { code.push(line); continue; }
            const re = new RegExp(INPUT_SRC, 'g');
            let m;
            while ((m = re.exec(line))) {
              const child = f.raws.get(m[2]);
              if (child) await step(child);
            }
          }
        };
        await step(rootPath);
      };

      // ONE lock for the whole sequence: reset + every cell + \py{} evaluation
      // run atomically — a manual Shift+Enter can never mutate the namespace
      // between running the cells and reading the values for the document.
      await withKernelLock(async () => {
        // Background compiles reuse the namespace when no cell code changed;
        // python-only documents always run (running the cells IS the compile),
        // and manual compiles always run (ground truth).
        let skipped = !showViewer && !pythonOnly && sig === lastCellSig && !lastCellsFailed;
        if (skipped) {
          for (const [p, f] of files) f.renderByCode = { ...(lastRenderByFile.get(p) || {}) };
        } else {
          await runTree();
        }

        // 2) Resolve \py{...} expressions against that exact namespace.
        if (exprs.length) valueMap = await evalExpressions(exprs, { cwd });

        // Self-heal: if the skip met a stale namespace (e.g. the kernel was
        // restarted), rerun everything once within the same lock.
        if (skipped && exprs.some((x) => valueMap[x] && !valueMap[x].ok)) {
          skipped = false;
          await runTree();
          if (exprs.length) valueMap = await evalExpressions(exprs, { cwd });
        }
        lastCellSig = sig;
        lastRenderByFile = new Map([...files].map(([p, f]) => [p, { ...f.renderByCode }]));
        lastCellsFailed = cellsFailed;
      });
    }

    // Python-only .pltx (no LaTeX document): running the cells IS the compile.
    if (pythonOnly) {
      state.lastLog =
        (problems ? `===== Avisos de Pyx =====${problems}\n\n` : '') +
        'Documento sin LaTeX: se han ejecutado las celdas Python (no se genera PDF).';
      state.lastCompileOk = !problems;
      return;
    }

    for (const e of pyValExprs) {
      if (valueMap[e] && !valueMap[e].ok) problems += `\n[\\py{${e}}] ${valueMap[e].value}`;
    }
    for (const c of condExprs) {
      const v = valueMap[pyifKey(c)];
      if (v && !v.ok) problems += `\n[\\pyif{${c}}] ${v.value}`;
    }

    // 3) Write a processed .build copy of every file that needs one (cells,
    //    \py{}, or a rewritten \input below it), point parents at their
    //    children's builds, and compile the ROOT build as <stem>.pdf.
    const needs = new Map();
    const calcNeeds = (path) => {
      if (needs.has(path)) return needs.get(path);
      needs.set(path, false); // cycle guard
      const f = files.get(path);
      let n = pyxLike(path, f.content)
        && (parseCellsText(f.content).length > 0 || findPyExprs(f.content).length > 0
            || findPyIfExprs(f.content).length > 0);
      for (const child of f.raws.values()) if (calcNeeds(child)) n = true;
      needs.set(path, n);
      return n;
    };
    calcNeeds(rootPath);

    for (const [path, f] of files) {
      if (path !== rootPath && !needs.get(path)) continue;
      let processed = pyxLike(path, f.content)
        ? resolvePyText(resolvePyIf(neutralizeCells(f.content, f.renderByCode), valueMap), valueMap)
        : f.content;
      processed = processed.replace(new RegExp(INPUT_SRC, 'g'), (all, cmd, raw) => {
        const child = f.raws.get(raw);
        if (!child || !needs.get(child)) return all;
        const nraw = /\.tex$/i.test(raw) ? raw.replace(/\.tex$/i, '.build.tex') : raw + '.build';
        return `\\${cmd}{${nraw}}`;
      });
      await writeTextFile(path.replace(/\.(tex|pltx)$/i, '') + BUILD_SUFFIX, processed);
    }
    const buildPath = joinPath(cwd, stem + BUILD_SUFFIX);

    // Feed the log parser what it needs for TeXstudio-grade file attribution:
    // which build name maps to which real file, and the project file set.
    state.lastRootFile = baseName(buildPath);
    state.lastBuildMap = Object.fromEntries([...files.keys()].map((p) => [
      (baseName(p).replace(/\.(tex|pltx)$/i, '') + BUILD_SUFFIX).toLowerCase(), p,
    ]));
    state.lastKnownFiles = [...files.keys()].flatMap((p) => [
      baseName(p).toLowerCase(),
      (baseName(p).replace(/\.(tex|pltx)$/i, '') + BUILD_SUFFIX).toLowerCase(),
    ]);

    const allText = [...files.values()].map((f) => f.content).join('\n');
    const passes = /\\(tableofcontents|ref|cite|listoffigures|listoftables)\b/.test(allText) ? 2 : 1;
    // % !TeX program = pdflatex — the document names its own engine, like in
    // TeXstudio. An explicit per-document choice (Configuración) still wins.
    const magicEngine = (
      /^\s*%\s*!TeX\s+(?:TS-)?program\s*=\s*(pdflatex|xelatex|lualatex)\s*$/im.exec(rootContent)
      || []
    )[1];
    const engine = rootDoc.engine || doc.engine || (magicEngine || '').toLowerCase()
      || state.env.latex || 'xelatex';
    const res = await compileLatex(buildPath, engine, passes, stem);

    state.lastLog =
      (problems ? `===== Avisos de Pyx =====${problems}\n\n` : '') + (res.log || '');
    state.lastCompileOk = res.ok;

    // TeXstudio-style: pdf_path is only set when THIS run wrote a PDF, so show
    // it even if TeX recovered from errors — they stay listed in the log panel.
    if (res.pdf_path) {
      lastPdfPath = res.pdf_path;
      state.lastPdfPath = res.pdf_path; // forward search reads this
      if (auxOpen()) {
        // The detached window is the active viewer: refresh THAT one (the
        // in-app pane is closed; it reloads via reloadLastPdf when the
        // auxiliary window closes).
        emitToWindow('pdf-viewer', 'viewer:load', encodeURIComponent(res.pdf_path));
      } else {
        await loadPdf(res.pdf_path);
      }
    }
    // Never force the log open: compilation is silent unless the user opens it.
    return res;
  } catch (e) {
    state.lastLog = String((e && e.message) || e);
    state.lastCompileOk = false;
  } finally {
    state.compiling = false;
  }
}
