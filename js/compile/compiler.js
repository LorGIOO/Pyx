// Compile orchestration: save → run cells → resolve \py{...} → write a build
// copy with values substituted → run the engine → load the PDF. Single action.

import { state, activeDoc } from '../core/state.js';
import { getDocContent, getViewOfDoc } from '../editor/setup.js';
import {
  writeTextFile, readTextFile, readDir, pathExists, compileLatex, emitToWindow,
  pltxRead, fileStamps, buildDirFor, createDir,
} from '../core/platform.js';
import { relativeTo } from '../core/paths.js';
import { execCellFor } from '../editor/cells.js';
import { parseCells, parseCellsText, cellKey, markerId } from '../editor/cell-parse.js';
import { docIdOf } from '../editor/doc-id.js';
import { runCellCode, evalExpressions, withKernelLock, nsPrefix } from '../editor/cell-runner.js';
import { hashString } from '../core/hash.js';
import { setBuildMaps } from './build-maps.js';
import {
  findPyExprs, resolvePyText, neutralizeCells, dirOf, joinPath, stemOf, baseName, BUILD_SUFFIX,
  findPyIfExprs, resolvePyIf, collectPyIfConds, pyifKey, createVerbatimTracker,
  safetyPreamble, injectPreamble, findPyxLeaks, buildToSrcLine, scanVerbatimUse,
} from './latex-bridge.js';
import { loadPdf } from '../pdf/preview.js';
import { auxOpen } from '../solid/stores/previewStore.js';
import { saveActiveAs } from '../solid/stores/docStore.js';
import { general } from '../solid/stores/settingsStore.js';

/* ---- live compile (TeXstudio-style) ----
   The editor schedules a background compile shortly after typing stops; the
   heavy work (xelatex, Python) runs OFF the UI thread (async Tauri commands),
   so writing never blocks. Unsaved documents are skipped — a save dialog must
   never pop up mid-keystroke.

   ADAPTIVE DELAY. The configured delay (~1.1 s) assumes a compile costs about a
   second. On a thousand-page project with dozens of \input'ed chapters, xelatex
   takes tens of seconds — so every pause queued another compile behind the one
   still running, the queue never drained, and the app looked hung while the CPU
   melted. We now measure how long the last compile actually took and wait
   proportionally longer before starting the next one. A project that takes a
   minute to build simply stops auto-compiling on every pause; Ctrl+Shift+B
   still compiles on demand, immediately. */
let liveTimer = null;
let lastCompileMs = 0;

/** How long to wait after typing stops before compiling in the background. */
function liveDelay() {
  const base = Math.max(300, +general.liveDelay || 1100);
  // Never spend more than ~1/4 of the time compiling in the background: if the
  // last build took 20 s, wait at least 60 s before starting another one.
  const proportional = lastCompileMs * 3;
  return Math.max(base, Math.min(proportional, 120_000));
}

/** True when the project is so slow to build that live compiling does more harm
 *  than good. Surfaced in the status bar / log so it isn't a silent surprise. */
export function liveCompileSuspended() {
  return lastCompileMs > 40_000;
}

export function scheduleLiveCompile() {
  if (!state.liveCompile) return;
  const doc = activeDoc();
  if (!doc || doc.kind || !doc.path) return;
  clearTimeout(liveTimer);
  // A build this heavy must not run off a typing pause at all.
  if (liveCompileSuspended()) return;
  liveTimer = setTimeout(() => {
    if (state.compiling) { scheduleLiveCompile(); return; } // trail the current run
    const d = activeDoc();
    if (!d || d.kind || !d.path) return;
    // Python-only documents (cells, no LaTeX, no master) run cells ON DEMAND:
    // auto-running them on every typing pause could re-trigger long
    // computations. CHILD files of a master (text fragments) DO live compile —
    // compileActive resolves and builds their root document.
    //
    // The gate reads the OPEN EDITOR STATE when there is one: `getDocContent`
    // materializes the whole rope into a string and splits it into lines, and
    // this runs on every typing pause. `parseCells` is memoized on the rope, so
    // the common path now costs nothing.
    const view = getViewOfDoc(d.id);
    const cellCount = view
      ? parseCells(view.state).length
      : parseCellsText(getDocContent(d.id)).length;
    const isPyx = !(d.fileName || '').toLowerCase().endsWith('.tex') || cellCount > 0;
    if (isPyx && cellCount > 0) {
      // Only materialize the text when we actually have to answer "is there a
      // \documentclass or a % !TEX root in here?".
      const c = getDocContent(d.id);
      if (!/\\documentclass|\\begin\s*\{document\}/.test(c)
        && !/^\s*%\s*!TEX\s+root/im.test(c)) return;
    }
    compileActive(false);
  }, liveDelay());
}

// Last successfully compiled PDF — reloaded into the in-app pane when the
// auxiliary viewer window closes (all updates went THERE while it was open).
let lastPdfPath = null;
export function reloadLastPdf() {
  if (lastPdfPath) loadPdf(lastPdfPath).catch(() => {});
}

/* Handcalcs output, cached by the fingerprint of the cell body that produced
   it. A cell the kernel legitimately skips (see the namespace ledger in
   cell-runner) still has to contribute its typeset block to the build, and its
   code is by definition unchanged — so the cached LaTeX is exactly right. */
const renderCache = new Map(); // codeHash -> latex | null
const RENDER_CACHE_MAX = 500;
function cacheRender(hash, latex) {
  if (renderCache.size >= RENDER_CACHE_MAX) {
    renderCache.delete(renderCache.keys().next().value);
  }
  renderCache.set(hash, latex || null);
}

/* Fingerprint of the last text written to each .build.tex. On a big project
   most chapters are identical between compiles, so re-writing them all every
   time was pure disk churn (and, with a live compile firing on every typing
   pause, constant). Storing the FINGERPRINT rather than the text keeps a
   thousand-page project from being held in memory a second time. */
const lastBuildWritten = new Map(); // buildPath -> content fingerprint

// A cell may inject LaTeX into the document ONLY when it declares one of the
// handcalcs cell magics on its own line. Anything else (stdout, results,
// figures) stays in the editor: the user asks, Python answers — the PDF only
// changes when the user says so.
const HANDCALCS_MAGIC = /^\s*%%(render|tex)\b/m;

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
    // Keep forward slashes as-is: Windows accepts them in paths, and
    // converting to backslashes would break Linux/macOS.
    const rel = magic[1];
    const p = /^([a-zA-Z]:[\\/]|\/)/.test(rel) ? rel : joinPath(dir, rel);
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

/** Directory of the ACTIVE document's root (master) document.
 *
 * Every kernel execution runs with THIS as its cwd — also manual Shift+Enter
 * runs from an \input'ed chapter. It keeps the whole project on one working
 * directory, so `figure()` writes into the single project-level `xref` folder
 * instead of sprouting a copy next to every child file, and relative paths in
 * cells behave identically no matter which file the cell lives in. */
export async function activeRootDir() {
  const doc = activeDoc();
  if (!doc || doc.kind || !doc.path) return undefined;
  try {
    const root = await resolveRootPath(doc, getDocContent(doc.id));
    return dirOf(root);
  } catch (_) {
    return dirOf(doc.path);
  }
}

/* ---- multi-file gather / run / build (document order, depth ≤ 3) ---- */
const INPUT_SRC = '\\\\(input|include)\\s*\\{([^}]+)\\}';
const isPyxPath = (p) => !/\.tex$/i.test(p); // per-FILE rule: .tex = pure LaTeX…
// …UNLESS it actually contains Python cells: a .tex with %#python cells is
// processed (cells run, \py{} resolved) just like a .pltx, so cells can be
// dropped into an existing LaTeX file.

/* ---- disk cache for \input'ed children -------------------------------------
   The tree is walked on EVERY compile, including the live ones a typing pause
   triggers. Re-reading every chapter of a hundred-file project from disk each
   time meant hundreds of IPC round-trips per keystroke pause. We keep the text
   we already read and re-read a file only when its {mtime, size} stamp moved.
   Files that are open in the editor never come from here — their live buffer is
   the truth. */
const diskCache = new Map(); // path -> { mtime, size, content }

async function readChildrenCached(paths) {
  const out = new Map();
  if (!paths.length) return out;
  let stamps = [];
  try {
    stamps = await fileStamps(paths);
  } catch (_) {
    stamps = paths.map(() => ({ mtime: -1, size: -1 })); // fall back to reading
  }
  await Promise.all(paths.map(async (p, i) => {
    const st = stamps[i] || { mtime: -1, size: -1 };
    const hit = diskCache.get(p);
    if (hit && st.mtime >= 0 && hit.mtime === st.mtime && hit.size === st.size) {
      out.set(p, hit.content);
      return;
    }
    try {
      const content = await readSourceFile(p);
      diskCache.set(p, { mtime: st.mtime, size: st.size, content });
      out.set(p, content);
    } catch (_) { /* unreadable child: skipped by the caller */ }
  }));
  return out;
}

/* Where an \input's text resolves to on disk.
 *
 * "cap/uno" and the folder it sits in do not change between compiles, but
 * answering it costs a pathExists round-trip per candidate extension. A
 * hundred-chapter project paid all of them, in series, on EVERY compile —
 * including the ones a typing pause fires. Hits are kept for the session;
 * misses are not, so a chapter written after the last compile is still found. */
const childPathCache = new Map();

async function resolveChildPath(rootDir, raw) {
  // Forward slashes work on every OS (Windows included) — converting them to
  // backslashes broke \input resolution on Linux/macOS.
  const rel = raw.trim();
  const key = `${rootDir} ${rel}`;
  const hit = childPathCache.get(key);
  if (hit) return hit;
  const base = /^([a-zA-Z]:[\\/]|\/)/.test(rel) ? rel : joinPath(rootDir, rel);
  const cands = /\.[a-z0-9]+$/i.test(base) ? [base] : [base + '.tex', base + '.pltx'];
  // Both candidates at once, but `.tex` still wins: Promise.all preserves order.
  const found = (await Promise.all(
    cands.map(async (c) => (await pathExists(c) ? c : null)))).find(Boolean) || null;
  if (found) childPathCache.set(key, found);
  return found;
}

/**
 * Analyze a file ONCE per compile.
 *
 * Every scan here is a full pass over the file's text, and the old code
 * re-derived them over and over: `pyxLike` (parseCellsText), `anyCells`
 * (again), the cell signature (again), `pyValExprs` (findPyExprs), `condExprs`
 * (collectPyIfConds), then `calcNeeds` redid parseCellsText + findPyExprs +
 * findPyIfExprs, and finally `runTree` re-split the file line by line to
 * execute the cells. Seven-plus passes per file, on a compile that fires every
 * time typing pauses.
 *
 * Now each file is walked once, here, and everything downstream reads these
 * fields.
 *
 * `events` is the file's cells and \input calls in DOCUMENT ORDER — the order
 * the runner must follow, since a child's cells run at its \input position.
 */
function analyzeFile(path, content) {
  const events = [];
  const cells = [];
  // Verbatim environments and lstlisting styles this file OPENS: the root
  // preamble must guarantee they exist, or the engine typesets the block as
  // prose and the code inside it lands on the page (see safetyPreamble).
  const verbUse = { envs: new Set(), styles: new Set() };
  // Markers inside verbatim environments (minted…) are DISPLAYED code, not
  // cells — the same rule parseCells and neutralizeCells apply.
  const inVerb = createVerbatimTracker();
  const inputRe = new RegExp(INPUT_SRC, 'g');
  let inCell = false, code = [], headerLn = 0, lineNo = 0;
  let cellIdx = -1, cellId = null;

  for (const line of content.split(/\r?\n/)) {
    lineNo++;
    const verb = inCell ? false : inVerb(line);
    if (!inCell) {
      if (!verb && line.indexOf('%#') >= 0 && line.trim().startsWith('%#python')) {
        inCell = true; code = []; headerLn = lineNo;
        // Same SHAPE as the cells the editor's parser produces ({id, index}),
        // so `cellKey` resolves identically on both paths — the compiler files
        // a result under exactly the key the editor reads it back from.
        // neutralizeCells numbers id-less cells the same way, so the handcalcs
        // blocks land back in the right places.
        cellIdx++;
        cellId = markerId(line);
        continue;
      }
      if (line.indexOf('\\') >= 0) {
        scanVerbatimUse(line, verbUse);
        inputRe.lastIndex = 0;
        let m;
        while ((m = inputRe.exec(line))) events.push({ kind: 'input', raw: m[2] });
      }
      continue;
    }
    if (line.indexOf('%#') >= 0 && line.trim().startsWith('%#end')) {
      inCell = false;
      const body = code.join('\n');
      const cell = {
        code: body, headerLn, id: cellId, index: cellIdx, codeHash: hashString(body),
      };
      cells.push(cell);
      events.push({ kind: 'cell', cell });
      continue;
    }
    code.push(line);
  }

  // A cell whose %#end is missing swallows the rest of the file: it never
  // runs, and the build drops everything below it. Silent truncation is the
  // worst outcome of all — surface it as a problem the user can act on.
  const unterminated = inCell ? headerLn : 0;

  // .tex is pure LaTeX unless it actually carries Python cells.
  const isPyx = isPyxPath(path) || cells.length > 0;
  const pyExprs = isPyx ? findPyExprs(content) : [];
  const conds = isPyx ? collectPyIfConds(content) : [];
  const hasPyIf = isPyx && findPyIfExprs(content).length > 0;
  return {
    events,
    cells,
    isPyx,
    pyExprs,
    conds,
    verbEnvs: verbUse.envs,
    verbStyles: verbUse.styles,
    unterminated,
    // \py / \pyif ANYWHERE, verbatim included: a shown \py{…} still needs the
    // macro to exist, in case the environment showing it fails to load.
    usesPy: content.indexOf('\\py') >= 0,
    usesGraphics: content.indexOf('\\includegraphics') >= 0,
    // Does this file need a processed .build copy of its own?
    needsBuild: isPyx && (cells.length > 0 || pyExprs.length > 0 || hasPyIf),
  };
}

// path -> { content, raws: Map(rawArg -> childPath), renders, ...analysis }.
// Saves any modified open child to disk on the way (compiling = saving what it
// uses).
async function gatherTree(rootPath, rootContent, rootDir) {
  const files = new Map();
  const walk = async (path, content, depth) => {
    const f = {
      content,
      raws: new Map(),
      renders: {}, // cell key -> handcalcs LaTeX
      ...analyzeFile(path, content), // ONE scan per file, per compile
    };
    files.set(path, f);
    if (depth >= 3) return;

    // Resolve this file's \input targets first, then batch-read the ones that
    // aren't already open in the editor.
    // Resolve every \input of this file in ONE parallel batch. Doing it in the
    // matching loop meant a round-trip per chapter, in series, and that is the
    // cost that grows with the size of the project.
    const re = new RegExp(INPUT_SRC, 'g');
    const raws = [];
    let m;
    while ((m = re.exec(content))) raws.push(m[2]);
    if (!raws.length) return;
    const resolved = await Promise.all(raws.map((r) => resolveChildPath(rootDir, r)));

    const pending = [];
    const queued = new Set(); // a file \input twice must be read once
    raws.forEach((raw, i) => {
      const child = resolved[i];
      if (!child) return;
      f.raws.set(raw, child);
      if (files.has(child) || queued.has(child)) return;
      queued.add(child);
      pending.push(child);
    });
    if (!pending.length) return;

    const fromDisk = [];
    const live = new Map(); // path -> content taken from an open editor buffer
    for (const child of pending) {
      const open = state.documents.find((d) => d.path === child && !d.kind);
      if (!open) { fromDisk.push(child); continue; }
      const c = getDocContent(open.id);
      live.set(child, c);
      if (open.modified && !isPltx(child)) {
        // .pltx children are ZIP containers (packed on Save) — never overwrite
        // with raw text; the child's .build.tex is what actually compiles.
        await writeTextFile(child, c);
        open.modified = false;
        diskCache.delete(child); // we just changed it
      }
    }
    const disk = await readChildrenCached(fromDisk);

    for (const child of pending) {
      if (files.has(child)) continue; // a sibling branch got there first
      const c = live.has(child) ? live.get(child) : disk.get(child);
      if (c == null) continue; // unreadable
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
  const t0 = performance.now();
  // Where the time actually goes, reported at the end of the log. Compiling is
  // this app's inner loop, and when it feels slow the only useful question is
  // "slow doing what" — guessing that answer has already been wrong once.
  const phase = { cells: 0, tex: 0, ran: 0, total: 0 };
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
    const cellProblem = (label, stderr, docLine) => {
      const last = (stderr || '').split('\n').filter((l) => l.trim()).pop();
      const at = docLine ? ` · línea ${docLine}` : '';
      problems += `\n[${label}${at}] ${last || 'error de ejecución'}`;
    };

    // 1) Gather the \input tree and run every Python cell in DOCUMENT ORDER
    //    (a child's cells run at its \input position). Per-file rule: .tex is
    //    pure LaTeX; only .pltx files get cells and \py{}.
    //
    //    gatherTree analyzed each file exactly once — read the results, never
    //    rescan the text here.
    const files = await gatherTree(rootPath, rootContent, cwd);
    const rootF = files.get(rootPath);
    const isPyx = rootF.isPyx;
    const pythonOnly = isPyx && !/\\documentclass|\\begin\s*\{document\}/.test(rootContent);
    const pyFiles = [...files.keys()].filter((p) => files.get(p).isPyx);
    const pyValExprs = pythonOnly ? [] : [
      ...new Set(pyFiles.flatMap((p) => files.get(p).pyExprs.map((e) => e.expr))),
    ];
    // \pyif{cond}{…}{…} conditions are evaluated as bool(cond) alongside \py{}.
    const condExprs = pythonOnly ? [] : [
      ...new Set(pyFiles.flatMap((p) => files.get(p).conds)),
    ];
    const exprs = [...pyValExprs, ...condExprs.map(pyifKey)];
    let valueMap = {};
    const anyCells = pyFiles.some((p) => files.get(p).cells.length > 0);

    if (anyCells || exprs.length) {
      /* The project's cells in EXECUTION order: document order, descending
         into each \input where it appears. gatherTree already recorded that
         order as a flat event list per file (analyzeFile), so this walks it
         directly instead of re-splitting every file of the project. */
      const runOrder = [];
      {
        const seen = new Set();
        const walkOrder = (path) => {
          if (seen.has(path)) return;
          seen.add(path);
          const f = files.get(path);
          if (!f) return;
          let n = 0;
          for (const ev of f.events) {
            if (ev.kind === 'input') {
              const child = f.raws.get(ev.raw);
              if (child) walkOrder(child);
              continue;
            }
            runOrder.push({ path, file: f, cell: ev.cell, nth: ++n });
          }
        };
        walkOrder(rootPath);
      }
      const hashes = runOrder.map((e) => e.cell.codeHash);
      phase.total = runOrder.length;

      /* Run the cells the kernel does not already hold.
       *
       * The kernel keeps a ledger of exactly which cell bodies built its
       * current namespace (cell-runner). When that ledger is a prefix of what
       * we are about to run — the normal case when a background compile fires
       * because you edited a paragraph, or changed only the last cell — those
       * cells need not run again. A divergence anywhere, a different working
       * directory, or an unknown namespace forces a reset and a full re-run,
       * so a skip can never produce a value that a full run would not.
       *
       * "Compilar y ver" used to force a reset, on the reasoning that a manual
       * compile is the ground truth. It cost a full re-run — every import,
       * every dataset, every simulation — on EVERY press, which is most of the
       * 10-50 s a compile used to take. The ledger already provides that
       * guarantee: it skips a prefix only when it is exactly a prefix, and any
       * doubt at all falls back to a reset. Forcing one on top bought nothing
       * and charged for it every time. A full re-run is still available, and
       * still explicit: "Reiniciar el kernel". */
      const runTree = async (force) => {
        problems = '';
        const start = force ? 0 : nsPrefix(hashes, cwd);
        if (start === 0) await runCellCode('', { cwd, reset: true });
        for (let i = start; i < runOrder.length; i++) {
          phase.ran++;
          const { path, cell, nth } = runOrder[i];
          const od = state.documents.find((d) => d.path === path && !d.kind);
          const view = od ? getViewOfDoc(od.id) : null;
          const res = await execCellFor(view, view ? docIdOf(view.state) : null, cell, cwd);
          // HARD RULE: only a cell that EXPLICITLY declares a handcalcs magic
          // (%%render / %%tex) may put anything into the PDF. The kernel
          // honors this, but the document is the user's deliverable — gate it
          // here too, so no kernel regression can ever leak a cell's output
          // into the typeset document.
          cacheRender(cell.codeHash,
            res && res.render && HANDCALCS_MAGIC.test(cell.code) ? res.render : null);
          if (res && res.ok === false) {
            // Absolute document line of the failure (VSCode-style precision).
            const el = res.error && res.error.line != null ? cell.headerLn + res.error.line : null;
            // The traceback is structured (colored in the cell): the problem
            // message comes from it, with lines mapped to the document.
            const emsg = res.error
              ? `${res.error.type}: ${String(res.error.msg || '').replace(
                  /\b(line|línea)\s+(\d+)/gi, (a, w, m2) => `${w} ${cell.headerLn + +m2}`)}`
              : res.stderr;
            cellProblem(`${baseName(path)} · celda ${nth}`, emsg, el);
            // Everything below a failed cell would run against a namespace we
            // can no longer describe: stop rather than produce numbers that
            // look right and are not.
            break;
          }
        }
        // Every cell contributes its typeset block, skipped ones included:
        // their code is unchanged, so the cached render is exactly current.
        for (const f of files.values()) f.renders = {};
        for (const { file, cell } of runOrder) {
          const latex = renderCache.get(cell.codeHash);
          if (latex) file.renders[cellKey(cell)] = latex;
        }
      };

      // ONE lock for the whole sequence: reset + every cell + \py{} evaluation
      // run atomically — a manual Shift+Enter can never mutate the namespace
      // between running the cells and reading the values for the document.
      const tCells = performance.now();
      await withKernelLock(async () => {
        await runTree(false);

        // 2) Resolve \py{...} expressions against that exact namespace.
        if (exprs.length) valueMap = await evalExpressions(exprs, { cwd });

        // Self-heal: if an incremental run met a namespace that had drifted
        // (the kernel was restarted between compiles, a cell was interrupted),
        // rerun everything once inside the same lock.
        //
        // This is the ONLY thing standing between an incremental run and a
        // wrong number, and it is enough: a namespace that no longer holds
        // what the document expects shows up as a \py{} that fails to
        // evaluate, and that triggers the full re-run right here, before
        // anything reaches the PDF.
        if (exprs.some((x) => valueMap[x] && !valueMap[x].ok)) {
          await runTree(true);
          if (exprs.length) valueMap = await evalExpressions(exprs, { cwd });
        }
      });
      phase.cells = performance.now() - tCells;
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
    //    `needsBuild` came from the single per-file analysis; this only
    //    propagates it up the tree.
    const needs = new Map();
    const calcNeeds = (path) => {
      if (needs.has(path)) return needs.get(path);
      needs.set(path, false); // cycle guard
      const f = files.get(path);
      let n = f.needsBuild;
      for (const child of f.raws.values()) if (calcNeeds(child)) n = true;
      needs.set(path, n);
      return n;
    };
    calcNeeds(rootPath);

    // Guards for the ROOT preamble: every verbatim environment and lstlisting
    // style the PROJECT uses must actually exist, and a \py{}/\pyif{} that
    // survived resolution must print nothing. Without this, an environment the
    // preamble forgot to load (\usepackage{listings}…) makes the engine typeset
    // the block as prose, spilling Python cells and \py{} internals onto the
    // page. Aggregated over every file — a child's lstlisting needs `listings`
    // loaded in the ROOT.
    const use = { envs: new Set(), styles: new Set(), usesPy: false, usesGraphics: false };
    for (const [path, f] of files) {
      for (const e of f.verbEnvs) use.envs.add(e);
      for (const s of f.verbStyles) use.styles.add(s);
      if (f.usesPy) use.usesPy = true;
      if (f.usesGraphics) use.usesGraphics = true;
      if (f.unterminated) {
        problems += `\n[${baseName(path)} · línea ${f.unterminated}] celda sin %#end:`
          + ' no se ejecuta y el resto del archivo no llega al PDF.';
      }
    }
    const shim = safetyPreamble(use);

    /* Where each file's processed copy goes.
     *
     * Inside the project's WORKING DIRECTORY, which lives outside the user's
     * folder (see src-tauri/src/workspace.rs), mirroring the project's own
     * layout so `\input{cap/uno}` keeps working — the engine finds it through
     * TEXINPUTS. A file that sits outside the project (a chapter reached with
     * `../shared/…`) gets a flattened, fingerprinted name instead. */
    const outDir = await buildDirFor(rootPath);
    const buildRel = new Map();
    for (const path of files.keys()) {
      const rel = relativeTo(cwd, path);
      const name = rel !== null && rel !== ''
        ? rel.replace(/\.(tex|pltx)$/i, '') + BUILD_SUFFIX
        : `_ext/${hashString(path.toLowerCase())}-${stemOf(path)}${BUILD_SUFFIX}`;
      buildRel.set(path, name);
    }

    const lineMaps = {};
    /* Did anything the engine reads actually change?
     *
     * The build text is the ONLY thing that can move the PDF: it already
     * carries the resolved \py{} values and the handcalcs blocks, so if every
     * build file is byte-identical to the one compiled last time, a new run
     * would reproduce the same PDF. On a background compile that means the
     * whole 2-3 second engine pass — and the PDF reload after it — can be
     * skipped outright. Typing prose, editing a comment or running a cell that
     * prints to the editor now costs nothing at all. */
    let wroteAny = false;
    for (const [path, f] of files) {
      if (path !== rootPath && !needs.get(path)) continue;
      let processed = f.content;
      const buildFile = joinPath(outDir, buildRel.get(path));
      const mapKey = baseName(buildFile).toLowerCase();
      if (f.isPyx) {
        // The build is CLEAN LaTeX (cells removed, \py{} substituted): it
        // compiles standalone in TeXstudio. Removing lines shifts everything
        // below a cell, so keep the build↔source map for SyncTeX and the log.
        const neut = neutralizeCells(f.content, f.renders);
        processed = resolvePyText(resolvePyIf(neut.text, valueMap), valueMap);
        if (neut.srcLines) lineMaps[mapKey] = neut.srcLines;
        // Anything Pyx could NOT resolve is an internal incident: it is
        // reported here, in the app, and silenced in the build by the guards
        // above — it never becomes a mark on the page.
        for (const lk of findPyxLeaks(processed)) {
          const src = buildToSrcLine(lineMaps[mapKey], lk.line);
          problems += `\n[${baseName(path)} · línea ${src}] ${lk.token} sin resolver`
            + ' (revisa las llaves): no se imprimirá nada en el PDF.';
        }
      }
      processed = processed.replace(new RegExp(INPUT_SRC, 'g'), (all, cmd, raw) => {
        const child = f.raws.get(raw);
        if (!child || !needs.get(child)) return all;
        // Point at the child's copy by its path INSIDE the working directory.
        // It is relative, so the engine resolves it through TEXINPUTS.
        return `\\${cmd}{${buildRel.get(child)}}`;
      });
      if (shim && path === rootPath) {
        const inj = injectPreamble(processed, shim);
        if (inj) {
          processed = inj.text;
          // The guards add lines: keep the build↔source map exact, or SyncTeX
          // and every reported error line drift by the size of the block.
          const map = lineMaps[mapKey];
          const src = map ? buildToSrcLine(map, inj.buildLine) : inj.buildLine;
          if (map) {
            map.splice(inj.atIndex, 0, ...new Array(inj.count).fill(src));
          } else {
            // No map yet (the build was line-for-line the source): the
            // identity now has a step at the guards, so make it explicit.
            const lines = processed.split('\n').length;
            const built = new Array(lines);
            for (let i = 0; i < inj.atIndex; i++) built[i] = i + 1;
            for (let i = 0; i < inj.count; i++) built[inj.atIndex + i] = src;
            for (let i = inj.atIndex + inj.count; i < lines; i++) built[i] = i + 1 - inj.count;
            lineMaps[mapKey] = built;
          }
        }
      }
      // Don't rewrite a build file whose content didn't change. On a big project
      // most chapters are untouched between compiles, and skipping their writes
      // keeps the engine's own dependency checks (and the disk) quiet.
      const stampNow = processed.length + ':' + hashString(processed);
      if (lastBuildWritten.get(buildFile) === stampNow) continue;
      // The working directory mirrors the project's folders; create the branch
      // the first time a chapter in a subfolder is written.
      const parent = dirOf(buildFile);
      if (parent && parent !== outDir) await createDir(parent).catch(() => {});
      await writeTextFile(buildFile, processed);
      lastBuildWritten.set(buildFile, stampNow);
      wroteAny = true;
    }
    const buildPath = joinPath(outDir, buildRel.get(rootPath));

    // Published for forward/inverse SyncTeX and the log parser — keyed by the
    // build file's lowercase basename. These are plain data (arrays of tens of
    // thousands of integers) that nothing renders, so they live outside the
    // reactive store: behind a Proxy, every lookup paid a trap.
    setBuildMaps({
      lineMaps,
      project: cwd,
      work: outDir,
      root: baseName(buildPath),
      buildToReal: Object.fromEntries([...files.keys()].map((p) => [
        (baseName(p).replace(/\.(tex|pltx)$/i, '') + BUILD_SUFFIX).toLowerCase(), p,
      ])),
      known: new Set([...files.keys()].flatMap((p) => [
        baseName(p).toLowerCase(),
        (baseName(p).replace(/\.(tex|pltx)$/i, '') + BUILD_SUFFIX).toLowerCase(),
      ])),
    });

    // Two passes only when something needs references to settle. Test each file
    // separately and stop at the first hit — the old code concatenated EVERY
    // file of the project into one giant string just to run this one regex,
    // which on a thousand-page project meant allocating the whole document a
    // second time on every compile.
    const RERUN_RE = /\\(tableofcontents|ref|cite|listoffigures|listoftables)\b/;
    let needsTwo = false;
    for (const f of files.values()) {
      if (RERUN_RE.test(f.content)) { needsTwo = true; break; }
    }
    const passes = needsTwo ? 2 : 1;
    // % !TeX program = pdflatex — the document names its own engine, like in
    // TeXstudio. An explicit per-document choice (Configuración) still wins.
    const magicEngine = (
      /^\s*%\s*!TeX\s+(?:TS-)?program\s*=\s*(pdflatex|xelatex|lualatex)\s*$/im.exec(rootContent)
      || []
    )[1];
    const engine = rootDoc.engine || doc.engine || (magicEngine || '').toLowerCase()
      || state.env.latex || 'xelatex';

    // Nothing the engine reads changed, and the PDF from last time is still
    // there: running it again would burn seconds to produce the same bytes.
    // A MANUAL compile always runs — it is the user asking for ground truth.
    if (!showViewer && !wroteAny && lastPdfPath && await pathExists(lastPdfPath)) {
      state.lastLog = (problems ? `===== Avisos de Pyx =====${problems}\n\n` : '')
        + 'Sin cambios que afecten al PDF: no se ha recompilado.';
      state.lastCompileOk = !problems;
      return null;
    }

    const tTex = performance.now();
    const res = await compileLatex(buildPath, cwd, engine, passes, stem);
    phase.tex = performance.now() - tTex;

    state.lastLog =
      (problems ? `===== Avisos de Pyx =====${problems}\n\n` : '') + (res.log || '')
      + `\n\n===== Tiempos de Pyx =====\n`
      + `Celdas Python : ${Math.round(phase.cells)} ms `
      + `(${phase.ran} ejecutada${phase.ran === 1 ? '' : 's'} de ${phase.total})\n`
      + `Motor LaTeX   : ${Math.round(phase.tex)} ms `
      + `(${engine}, ${passes} pasada${passes === 1 ? '' : 's'})\n`
      + `Total         : ${Math.round(performance.now() - t0)} ms`;
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
    // Feed the live-compile backoff: the next background build waits in
    // proportion to how long this one really took.
    lastCompileMs = performance.now() - t0;
    state.compileMs = Math.round(lastCompileMs);
    state.liveSuspended = liveCompileSuspended();
    state.compiling = false;
  }
}
