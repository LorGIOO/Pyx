// Compile orchestration: save → run cells → resolve \py{...} → write a build
// copy with values substituted → run the engine → load the PDF. Single action.

import { state, activeDoc } from '../core/state.js';
import { getDocContent, getViewOfDoc } from '../editor/setup.js';
import {
  writeTextFile, readTextFile, readDir, pathExists, compileLatex, emitToWindow,
  pltxRead, fileStamps, buildDirFor, createDir, compileCancel, readSources,
} from '../core/platform.js';
import { relativeTo, normalizePath, samePath } from '../core/paths.js';
import { execCellFor } from '../editor/cells.js';
import { parseCells, parseCellsText, cellKey, markerId } from '../editor/cell-parse.js';
import { docIdOf } from '../editor/doc-id.js';
import {
  runCellCode, evalExpressions, withKernelLock, nsReads, nsPlan, nsMarkStale, interruptKernel, releaseKernelLock,
  HANDCALCS_MAGIC, cachedRender, renderKnown, prewarmModules, takeRestartReason,
  execKey, programOf, forgetNames, ensureStarNames, resolveNotebook, runLinkEntry,
  saveNotebookValues, notebookNote, nsHasRun, captureScope, scopeCurrent, takeLinkProblems,
} from '../editor/cell-runner.js';
import { setLinkWatch } from '../editor/link-watch.js';
import { executePlan } from '../editor/dep-plan.js';
import { scopeExpressions, applyScopeTags, occurrencesOf, stripScopeTag } from './py-scope.js';
import { setScopedValues, refreshGhostIn } from '../editor/py-ghost.js';
import {
  resolveLinkPath, notebookRefs, loadNotebook, documentReads, documentDefs, LINK_CMD_SRC, hasLinkCmd,
} from '../editor/notebooks.js';
import { importsOf } from './py-imports.js';
import { hashString } from '../core/hash.js';
import { setBuildMaps, persistBuildMaps, ensureBuildMaps } from './build-maps.js';
import {
  findPyExprs, resolvePyText, neutralizeCells, dirOf, joinPath, stemOf, baseName, BUILD_SUFFIX,
  findPyIfExprs, resolvePyIf, collectPyIfConds, pyifKey, createVerbatimTracker,
  safetyPreamble, injectPreamble, findPyxLeaks, defusePyxLeaks, buildToSrcLine,
  scanVerbatimUse, stripTexComment,
} from './latex-bridge.js';
import { loadPdf, getPdfPath } from '../pdf/preview.js';
import { auxOpen, lastArea } from '../solid/stores/previewStore.js';
import { saveActiveAs, saveWithEncoding, markSavedIfUnchanged } from '../solid/stores/docStore.js';
import { general } from '../solid/stores/settingsStore.js';

/* ---- live compile (TeXstudio-style) ----
   The editor schedules a background compile shortly after typing stops; the
   heavy work (xelatex, Python) runs OFF the UI thread (async Tauri commands),
   so writing never blocks. Unsaved documents are skipped — a save dialog must
   never pop up mid-keystroke.

   THE DELAY IS WHAT THE USER SET, and the compile it arms always fires.

   It used to be `max(setting, 3 × how long the last compile took)`, capped at
   two minutes, and above 40 s live compiling switched itself off. "How long
   the last compile took" was everything — the Python cells (the first compile
   of a session imports scipy and matplotlib: tens of seconds) and up to 20 s
   of waiting for the viewer. So after one slow first compile the next edit
   waited 45 s, or a minute and a half, before anything happened; past 40 s
   nothing ever happened again unless a manual compile came in under the
   limit. That is "it shows up minutes later, or never".

   What is left of the adaptation is only what protects a heavy document from
   compiling back to back: the wait is at least as long as the ENGINE took
   last time (LaTeX alone — never Python, never the viewer), and never more
   than ten seconds. Nothing suspends itself. And when the timer fires while a
   compile is running it does not arm itself again: compileActive folds the
   request into the one follow-up compile that starts when the current one
   ends, reading the text as it is then. */
let liveTimer = null;
let lastEngineMs = 0;
const LIVE_DELAY_MAX = 10_000;

/** How long to wait after typing stops before compiling in the background. */
export function liveDelay() {
  const base = Math.max(300, +general.liveDelay || 1000);
  return Math.max(base, Math.min(lastEngineMs, LIVE_DELAY_MAX));
}

/** Kept for callers of the old API: live compile no longer suspends itself. */
export function liveCompileSuspended() {
  return false;
}

/** Drop a background compile that was armed and has not fired. */
export function cancelLiveCompile() {
  clearTimeout(liveTimer);
  liveTimer = null;
  state.livePending = false;
}

export function scheduleLiveCompile() {
  if (!state.liveCompile) { cancelLiveCompile(); return; }
  const doc = activeDoc();
  if (!doc || doc.kind || !doc.path) return;
  clearTimeout(liveTimer);
  state.livePending = true; // the status LED shows "programada"
  liveTimer = setTimeout(() => {
    liveTimer = null;
    state.livePending = false;
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
    // Compiling already? compileActive queues it — no second timer.
    compileActive(false);
  }, liveDelay());
}

// Last successfully compiled PDF — reloaded into the in-app pane when the
// auxiliary viewer window closes (all updates went THERE while it was open).
let lastPdfPath = null;
// The root document the compile in flight is building, so the viewer can tell
// "wait, a newer PDF of what you are looking at is coming" from "that is
// another project's compile".
let compilingRoot = null;
export function reloadLastPdf() {
  if (lastPdfPath) loadPdf(lastPdfPath).catch(() => {});
}

/* The compile and the viewer are two things.
 *
 * The compile used to wait for the viewer — up to 20 s — before it counted as
 * finished. While it waited the next compile could not start, the wait was
 * added to "how long compiling takes" (which stretched the live-compile
 * delay), and if the viewer never answered the compile ended as "done" with
 * the old PDF on screen. Now the compile ends when the ENGINE ends. The viewer
 * loads the PDF on its own, says so while it does (state.pdfLoading), has its
 * own time limit and retry (preview.js), and reports its own failure. The
 * newest load always wins; an older one that finishes late is discarded there.
 */
let viewLoads = 0;
function showCompiledPdf(pdfPath, { gen, follow }) {
  if (auxOpen()) {
    // The detached window is the active viewer: refresh THAT one (the in-app
    // pane is closed; it reloads via reloadLastPdf when that window closes).
    emitToWindow('pdf-viewer', 'viewer:load', encodeURIComponent(pdfPath));
    return;
  }
  const mine = ++viewLoads;
  state.pdfLoading = true;
  loadPdf(pdfPath).then(async (info) => {
    if (!info) return; // superseded by a newer PDF, or no pane to show it in
    // A compile that typing fired: let the PDF show what was typed.
    if (follow && general.pdfFollowCursor !== false && lastArea() !== 'pdf') {
      import('../editor/commands.js').then((m) => m.followCursorInPdf()).catch(() => {});
    }
    const paintMs = await Promise.race([info.painted, new Promise((r) => setTimeout(() => r(null), 15000))]);
    // Where the viewer's time went, under the engine's — if that log is
    // still this compile's.
    if (gen === lastRealGen && state.lastLog.includes('===== Tiempos de Pyx =====') && !state.lastLog.includes('\nVisor PDF     :')) {
      state.lastLog += `\nVisor PDF     : ${paintMs == null ? '—' : Math.round(paintMs)} ms hasta la primera página `
        + `(leer ${Math.round(info.readMs)} ms, analizar ${Math.round(info.parseMs)} ms)`;
      lastReal = { ...lastReal, log: state.lastLog };
    }
  }).catch((e) => {
    if (mine !== viewLoads) return;
    // The viewer's failure is ADDED to the engine's log — it used to replace
    // it, and the one line left ("Invalid PDF structure") hid every error
    // that explained it.
    const why = `El visor no pudo abrir el PDF: ${String((e && e.message) || e)}`;
    state.compileReason = why;
    const body = state.lastLog.replace(/^===== Avisos de Pyx =====\n?/, '');
    state.lastLog = `===== Avisos de Pyx =====\n[Visor] ${why}\n${state.lastLog.startsWith('===== Avisos de Pyx =====') ? '' : '\n'}${body}`;
    state.lastCompileOk = false;
    lastReal = { ok: false, log: state.lastLog };
  }).finally(() => {
    if (mine === viewLoads) state.pdfLoading = false;
  });
}

// Paths from Rust carry the OS separator, paths built here forward slashes.
// samePath (paths.js): case- and separator-insensitive, `.`/`..` resolved.

/* Show a document's PDF the moment it opens.
 *
 * A .pltx carries the PDF of its last save, and opening it already unpacks it
 * into the working directory — but nothing displayed it: the viewer waited for
 * a compile, which the first time also means running every cell. On a long
 * report "opening" took as long as a full build. Word opens instantly because
 * it shows what was saved; so does this. The next compile replaces it. */
/* Does the PDF on screen belong to the document being edited?
 *
 * Every early return below used to leave the PREVIOUS project's PDF on screen
 * with nothing saying so: open a second report next to the first and you are
 * reading one document's text beside the other document's numbers. Saying it
 * out loud is the whole fix — the viewer is not cleared, because an old PDF is
 * still useful to look at as long as you know whose it is. */
function markPdfForeign(on) {
  // A viewer with nothing in it already says so on its own.
  state.pdfForeign = on && !!getPdfPath();
}

export async function showSavedPdf() {
  const doc = activeDoc();
  if (!doc || doc.kind) return;
  // No file on disk yet: no project, so no PDF of its own can exist.
  if (!doc.path) { markPdfForeign(true); return; }
  try {
    const content = getDocContent(doc.id);
    const root = await resolveRootPath(doc, content);
    // A compile of THIS project is about to show a newer PDF — wait for it.
    // One of ANOTHER project is not: switching documents while that ran used
    // to leave its PDF on screen, because this returned for any compile.
    if (state.compiling && samePath(compilingRoot, root)) return;
    const work = await buildDirFor(root);
    const pdf = joinPath(work, `${stemOf(root)}.pdf`);
    // Already on screen — and this is also the case of a chapter and its root,
    // which share one PDF: nothing to load and nothing to warn about.
    if (samePath(pdf, getPdfPath())) { markPdfForeign(false); return; }
    // Only a PDF at least as new as the document is ITS PDF. An older one was
    // built from some other version of the file — edited outside Pyx, copied
    // over from another machine — and showing it would present text and
    // numbers the document no longer contains.
    //
    // "The document" is the root AND the chapters it \inputs, as deep as the
    // compile follows them (3 levels). Checking the root alone showed a
    // report's old PDF as current after its chapters had been rewritten: the
    // chapters are where the text lives, and editing them never touches the
    // root. Chapters come through the compile's own read cache.
    const rootText = samePath(root, doc.path) ? content : await readSourceFile(root).catch(() => '');
    const children = [];
    const seen = new Set([root]);
    let level = [[root, rootText]];
    for (let depth = 0; depth < 3 && level.length; depth++) {
      const found = [];
      for (const [p, text] of level) {
        const kids = await Promise.all(analyzeFile(p, text).events
          .filter((e) => e.kind === 'input')
          .map((e) => resolveChildPath(dirOf(root), e.raw)));
        for (const c of kids) if (c && !seen.has(c)) { seen.add(c); found.push(c); }
      }
      children.push(...found);
      const texts = depth < 2 ? await readChildrenCached(found) : new Map();
      level = found.filter((c) => texts.has(c)).map((c) => [c, texts.get(c)]);
    }
    const [out, ...srcs] = await fileStamps([pdf, root, ...children]);
    // No PDF, or one older than the sources: this document has nothing current
    // to show, so whatever is up belongs to something else.
    if (!out || out.mtime < 0 || srcs.some((s) => s && s.mtime > out.mtime)) { markPdfForeign(true); return; }
    // A compile of this project started meanwhile: its PDF will be newer.
    if (state.compiling && samePath(compilingRoot, root)) return;
    lastPdfPath = pdf;
    state.lastPdfPath = pdf;
    markPdfForeign(false);
    // The line maps saved next to this PDF (pyx-mapas.json): without them a
    // Ctrl+click before the first compile of the session opened the internal
    // .build.tex copy, and forward search found nothing.
    await ensureBuildMaps(work).catch(() => false);
    await loadPdf(pdf);
  } catch (_) {
    // No saved PDF: the first compile will make one. Until then, say that what
    // is on screen is not this document's.
    markPdfForeign(true);
  }
}

/* What we last wrote to each .build.tex: the text's fingerprint, and the file's
   {mtime, size} right after writing it. On a big project most chapters are
   identical between compiles, so re-writing them all every time was pure disk
   churn. Storing the FINGERPRINT rather than the text keeps a thousand-page
   project from being held in memory a second time.

   A write is skipped only when the text matches AND the file on disk is still
   the one we wrote. Trusting the memory alone is how edits went missing: when
   something else rewrote a build file — restoring a .pltx's saved working
   directory did, on every read — the record still said "up to date", the
   write was skipped, and the engine compiled whatever was on disk. */
const lastBuildWritten = new Map(); // buildPath -> { fp, mtime, size }

// A cell may inject LaTeX into the document ONLY when it declares one of the
// handcalcs cell magics on its own line (HANDCALCS_MAGIC, cell-runner.js).
// Anything else stays in the editor: the PDF only changes when the user says so.

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
    // Only the document source (read_sources): the container's saved results
    // — megabytes of figures — and its build artifacts are not inflated just
    // to compile a chapter.
    const [src] = await readSources([path]).catch(() => [null]);
    if (src != null) return src;
    // A zip is read as a zip or not at all. A damaged one used to fall
    // through to a TEXT read, and the engine was handed binary garbage. Only
    // a legacy plain-text .pltx (is_zip false) is read as text; pltx_read
    // itself fails, with the reason, for a damaged zip or one without source.
    const r = await pltxRead(path);
    if (r && r.is_zip) return r.source;
  }
  return readTextFile(path);
}

// Folder scans for the root document, by document: what the folders held
// (`sig`: every candidate's path, mtime and size) and what was found.
const scanCache = new Map(); // doc path -> { sig, found }

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
      // The child's folder, then the one above. A document with no root at
      // all — a Python-only notebook, above all — used to READ every .tex
      // and .pltx there (whole containers, saved results included) on every
      // Mayús+Intro once the 20 s cache expired. Now the folders' listing and
      // stamps decide: unchanged folders cost two cheap calls and no reads,
      // and a change re-reads only the sources, in one round trip.
      const parent = dirOf(dir);
      const scans = parent && parent !== dir ? [dir, parent] : [dir];
      const lists = await Promise.all(scans.map((d) => readDir(d).catch(() => [])));
      const cands = [];
      for (const entries of lists) {
        for (const en of entries) {
          if (en.is_dir || !/\.(tex|pltx)$/i.test(en.name) || /\.build\.tex$/i.test(en.name)) continue;
          if (samePath(en.path, doc.path)) continue;
          cands.push(en.path);
        }
      }
      let stamps = [];
      try { stamps = await fileStamps(cands); } catch (_) { stamps = []; }
      const sig = stemOf(doc.path) + '\n' + cands.map((p, i) => {
        const s = stamps[i] || {};
        return `${p}|${s.mtime}|${s.size}`;
      }).join('\n');
      const hit = scanCache.get(doc.path);
      if (hit && hit.sig === sig && stamps.length === cands.length) {
        found = hit.found;
      } else {
        let texts = [];
        try { texts = await readSources(cands); } catch (_) { texts = []; }
        for (let i = 0; i < cands.length && !found; i++) {
          let c = texts[i];
          if (c == null) { try { c = await readSourceFile(cands[i]); } catch (_) { continue; } }
          if (/\\documentclass/.test(c) && needle.test(c)) found = cands[i];
        }
        scanCache.set(doc.path, { sig, found });
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
/** The \pynotebook / \pyfile commands of the ROOT document, when the file at
 *  `path` is one of its chapters ([] when it is its own root). Mayús+Intro in
 *  a chapter resolves them exactly as a compile does. */
const rootLinkCache = new Map(); // root path -> { mtime, size, refs }
export async function rootLinkRefs(path) {
  const doc = state.documents.find((d) => !d.kind && d.path && samePath(d.path, path));
  if (!doc) return [];
  const rootPath = await resolveRootPath(doc, getDocContent(doc.id));
  if (!rootPath || samePath(rootPath, doc.path)) return [];
  const open = state.documents.find((d) => !d.kind && samePath(d.path, rootPath));
  if (open) return notebookRefs(getDocContent(open.id));
  const [st] = await fileStamps([rootPath]);
  const hit = rootLinkCache.get(rootPath);
  if (hit && st && hit.mtime === st.mtime && hit.size === st.size) return hit.refs;
  const refs = notebookRefs(await readSourceFile(rootPath));
  if (st) rootLinkCache.set(rootPath, { mtime: st.mtime, size: st.size, refs });
  return refs;
}

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
const NOTEBOOK_RE = new RegExp(LINK_CMD_SRC, 'g'); // \pynotebook{…} / \pyfile{…}
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
  out.failed = new Map(); // path -> why it could not be read
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
    } catch (e) {
      // Unreadable (a damaged .pltx…): the caller shows it in the PDF and
      // lists the reason, instead of dropping the chapter without a word.
      out.failed.set(p, String((e && e.message) || e));
    }
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
  const key = `${rootDir}\n${rel}`; // no path contains a newline
  const hit = childPathCache.get(key);
  if (hit) return hit;
  // Normalized: `\\input{./cap.pltx}` must name the same file the editor has
  // open, or the compile reads the saved copy instead of the screen.
  const base = normalizePath(/^([a-zA-Z]:[\\/]|\/)/.test(rel) ? rel : joinPath(rootDir, rel));
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
  let cellIdx = -1, cellId = null, cellAt = 0;
  let notebooks = 0;
  // Offset of the current line in `content`: every event records where it
  // stands, so a \py{} can be placed between them (scopeExpressions).
  let pos = 0;
  let next = 0;

  for (const line of content.split(/\r?\n/)) {
    lineNo++;
    pos = next;
    next = pos + line.length + (content.charCodeAt(pos + line.length) === 13 ? 2 : 1);
    const verb = inCell ? false : inVerb(line);
    if (!inCell) {
      if (!verb && line.indexOf('%#') >= 0 && line.trim().startsWith('%#python')) {
        inCell = true; code = []; headerLn = lineNo; cellAt = pos;
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
        const code = stripTexComment(line); // `% \input{…}` is switched off
        scanVerbatimUse(code, verbUse);
        // …and so is one SHOWN inside a verbatim block (documentation often
        // prints an example \input): it is text, not a chapter to compile.
        if (!verb) {
          inputRe.lastIndex = 0;
          let m;
          while ((m = inputRe.exec(code))) events.push({ kind: 'input', raw: m[2], at: pos + m.index });
          // \pynotebook{cuaderno.ipynb}: the notebook's code cells run HERE.
          if (hasLinkCmd(code)) {
            NOTEBOOK_RE.lastIndex = 0;
            while ((m = NOTEBOOK_RE.exec(code))) {
              const cmd = /^\\pyfile/.test(m[0]) ? 'pyfile' : 'pynotebook';
              const raw = m[1].trim();
              // `ref` tells \pyfile{datos} (datos.py) from \pynotebook{datos}.
              events.push({ kind: 'notebook', raw, cmd, ref: `${cmd}{${raw}}`, at: pos + m.index });
              notebooks++;
            }
          }
        }
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
      events.push({ kind: 'cell', cell, at: cellAt });
      continue;
    }
    code.push(line);
  }

  // A cell whose %#end is missing swallows the rest of the file: it never
  // runs, and the build drops everything below it. Silent truncation is the
  // worst outcome of all — surface it as a problem the user can act on.
  const unterminated = inCell ? headerLn : 0;

  // .tex is pure LaTeX unless it actually carries Python cells (its own, or
  // a linked notebook's).
  const isPyx = isPyxPath(path) || cells.length > 0 || notebooks > 0;
  const pyExprs = isPyx ? findPyExprs(content) : [];
  const conds = isPyx ? collectPyIfConds(content) : [];
  const pyIfs = isPyx ? findPyIfExprs(content) : [];
  const hasPyIf = pyIfs.length > 0;
  return {
    events,
    cells,
    isPyx,
    pyExprs,
    pyIfs,
    conds,
    verbEnvs: verbUse.envs,
    verbStyles: verbUse.styles,
    unterminated,
    // \py / \pyif ANYWHERE, verbatim included: a shown \py{…} still needs the
    // macro to exist, in case the environment showing it fails to load.
    usesPy: content.indexOf('\\py') >= 0,
    usesGraphics: content.indexOf('\\includegraphics') >= 0,
    // Does this file need a processed .build copy of its own?
    //
    // A .pltx ALWAYS does, cells or not. On disk it is a zip, and the engine
    // cannot read a zip: a plain-LaTeX chapter saved as .pltx used to get no
    // copy, so its parent's \input kept pointing at the container and the
    // chapter never compiled. A .pltx has to work anywhere a .tex does.
    // A \pynotebook needs the copy too: it is where the guard that makes the
    // command print nothing reaches the engine.
    needsBuild: isPltx(path) || notebooks > 0 || (isPyx && (cells.length > 0 || pyExprs.length > 0 || hasPyIf)),
  };
}

/* Warm the kernel up for the document on screen: import the libraries its
   cells use — across the whole \input tree, since a root often has no cells of
   its own and its chapters do — while the user is still reading, so the first
   compile does not spend most of its time importing scipy and matplotlib.
   Read-only (the tree is gathered with `save: false`: opening a tab must never
   write a file), and harmless if the tree cannot be read. */
export async function prewarmActive() {
  const doc = activeDoc();
  if (!doc || doc.kind || !doc.path) return;
  try {
    const content = getDocContent(doc.id);
    const rootPath = await resolveRootPath(doc, content).catch(() => doc.path);
    const open = state.documents.find((d) => !d.kind && samePath(d.path, rootPath));
    const rootContent = open
      ? getDocContent(open.id)
      : await readSourceFile(rootPath).catch(() => '');
    const files = await gatherTree(rootPath, rootContent, dirOf(rootPath), { save: false });
    const names = [];
    for (const f of files.values()) {
      for (const c of f.cells || []) names.push(...importsOf(c.code));
      for (const nb of (f.notebooks && f.notebooks.values()) || []) for (const c of nb.cells) names.push(...importsOf(c.code));
    }
    if (names.length) await prewarmModules(names, dirOf(rootPath));
  } catch (_) { /* warm-up is an optimisation: never an error */ }
}

// path -> { content, raws: Map(rawArg -> childPath), renders, ...analysis }.
// Saves any modified open child to disk on the way (compiling = saving what it
// uses) — unless `save` is false (the warm-up only looks).
async function gatherTree(rootPath, rootContent, rootDir, { save = true } = {}) {
  const files = new Map();
  const walk = async (path, content, depth) => {
    const f = {
      content,
      raws: new Map(),
      renders: {}, // cell key -> handcalcs LaTeX
      ...analyzeFile(path, content), // ONE scan per file, per compile
    };
    files.set(path, f);
    // Linked Jupyter notebooks (\pynotebook): their code cells, re-read only
    // when the notebook changed on disk (notebooks.js).
    const nbRefs = new Map(); // ref -> its first event
    for (const e of f.events) if (e.kind === 'notebook' && !nbRefs.has(e.ref)) nbRefs.set(e.ref, e);
    if (nbRefs.size) {
      f.notebooks = new Map();
      // In document order (the Map keeps it), resolved in parallel.
      for (const ref of nbRefs.keys()) f.notebooks.set(ref, null);
      await Promise.all([...nbRefs.values()].map(async (ev) => {
        // The same resolver the editor uses (Mayús+Intro, Ctrl+clic,
        // autocompletado): root folder first, then this file's own.
        const p = await resolveLinkPath(rootDir, ev.raw, ev.cmd, dirOf(path));
        try {
          f.notebooks.set(ev.ref, { path: p, raw: ev.raw, cells: await loadNotebook(p) });
        } catch (e) {
          f.notebooks.set(ev.ref, { path: p, raw: ev.raw, cells: [], error: String((e && e.message) || e) });
        }
      }));
    }
    if (depth >= 3) return;

    // Resolve this file's \input targets first, then batch-read the ones that
    // aren't already open in the editor.
    // Resolve every \input of this file in ONE parallel batch. Doing it in the
    // matching loop meant a round-trip per chapter, in series, and that is the
    // cost that grows with the size of the project.
    // From the analysis, not a fresh regex over the text: that one also took
    // commented-out \input lines (running the cells of a chapter the author
    // had switched off) and \input text inside a Python cell's code.
    const raws = f.events.filter((e) => e.kind === 'input').map((e) => e.raw);
    if (!raws.length) return;
    const resolved = await Promise.all(raws.map((r) => resolveChildPath(rootDir, r)));

    const pending = [];
    const queued = new Set(); // a file \input twice must be read once
    raws.forEach((raw, i) => {
      const child = resolved[i];
      // Not found: left as written. The engine may still find a .tex on its
      // own search path, and when nothing is there the build's guards print
      // "No encontrado: <path>" in its place (latex-bridge.js).
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
      const open = state.documents.find((d) => !d.kind && samePath(d.path, child));
      if (!open) { fromDisk.push(child); continue; }
      const c = getDocContent(open.id);
      live.set(child, c);
      if (save && open.modified && !isPltx(child)) {
        // .pltx children are ZIP containers (packed on Save) — never overwrite
        // with raw text; the child's .build.tex is what actually compiles.
        await saveWithEncoding(child, c);
        // Not a bare `modified = false`: what was typed while the write was
        // in flight is not on disk (docStore.js).
        markSavedIfUnchanged(open, c);
        diskCache.delete(child); // we just changed it
      }
    }
    const disk = await readChildrenCached(fromDisk);

    for (const child of pending) {
      if (files.has(child)) continue; // a sibling branch got there first
      const c = live.has(child) ? live.get(child) : disk.get(child);
      if (c == null) {
        // Unreadable. It must leave the tree: every later step looks a
        // child up in `files`, and a missing entry crashed the compile with
        // "Cannot read properties of undefined". Its \input is replaced in
        // the build by a visible "No se pudo leer" (see the build loop).
        for (const [raw, p] of f.raws) {
          if (p === child) { f.raws.delete(raw); (f.unreadable ||= new Map()).set(raw, disk.failed.get(child) || ''); }
        }
        continue;
      }
      await walk(child, c, depth + 1);
    }
  };
  await walk(rootPath, rootContent, 0);
  return files;
}

/* A compile asked for while another one runs.
 *
 * One compile at a time is still the rule — two would run cells twice and race
 * on the same .build.tex. But a request arriving mid-compile used to be DROPPED
 * (and the button was disabled): press "Compilar" a second after typing, while
 * the live compile that the pause fired was still running, and nothing
 * happened — that run had read the text from before your last edit, so the
 * PDF came back without it.
 *
 * Now the request waits. However many arrive, they fold into ONE follow-up
 * compile that starts the moment the current one ends and reads the text as it
 * is THEN — so the last thing on screen is always the last thing you wrote.
 * `true` = someone asked to see the viewer. */
let queued = null;
let queuedForce = false; // a queued request that was an explicit "Compilar"
let queuedFresh = false; // …or a "Recompilar desde cero"

/* "Detener compilación".
 *
 * A compile is the cells, then the engine. Stopping it means stopping
 * whichever is running — the Python cell (a soft interrupt, as the cell's own
 * stop button does) or the LaTeX engine with the PDF driver it started — and
 * dropping the follow-up compile a queued request would have started. */
let cancelRequested = false;
export async function cancelCompile() {
  cancelLiveCompile(); // one that is only armed: it must not fire after a stop
  if (!state.compiling) return;
  cancelRequested = true;
  queued = null;
  queuedForce = false;
  queuedFresh = false;
  state.compileQueued = false;
  try { await compileCancel(); } catch (_) { /* no engine running */ }
  if (state.kernelStatus === 'busy') {
    try { await interruptKernel(); } catch (_) { /* best effort */ }
  }
}

/* The compile's own watchdog.
 *
 * Every step of a compile that can take long has a limit where it runs — the
 * engine in latex.rs (a loop, a silent stall, a ceiling per pass), a request
 * to Python in kernel.rs — so none of them should be able to hold a compile
 * for ever. This is the net under all of them, for the one thing they cannot
 * see: a step on THIS side that never comes back (an IPC call that is never
 * answered, a promise chain that lost its end). Without it that meant
 * "Compilando…" until Pyx was restarted, with every later request queued
 * behind it.
 *
 * Each step that makes progress marks the time (`beat`). When a phase has
 * gone longer than its limit without one, the compile is abandoned: the
 * engine and the running cell are stopped, the slot is freed, the reason is
 * shown, and whatever was queued runs. The abandoned run is ignored if it
 * ever unwinds (`runSeq`).
 *
 * The limits are far above anything the steps' own watchdogs allow, so this
 * never fires on a compile that is merely slow. Running the user's cells has
 * none unless a time limit per cell is set: a long simulation is not a hang,
 * the status says Python is running, and "Detener" stops it. */
let runSeq = 0;        // the compile that owns state.compiling
let lastBeat = 0;
let watchdog = null;
const beat = () => { lastBeat = performance.now(); };
function phaseLimit(phase) {
  if (phase === 'prep') return 3 * 60_000;
  // Three passes of at most 20 min each, plus the tools between them.
  if (phase === 'latex') return 80 * 60_000;
  if (phase === 'python') {
    const perCell = +general.cellTimeout || 0;
    return perCell > 0 ? perCell * 1000 + 60_000 : 0;
  }
  return 0;
}
function startWatchdog() {
  beat();
  clearInterval(watchdog);
  watchdog = setInterval(() => {
    if (!state.compiling) { clearInterval(watchdog); watchdog = null; return; }
    const limit = phaseLimit(state.compilePhase);
    if (!limit || !Number.isFinite(lastBeat) || performance.now() - lastBeat < limit) return;
    abandonCompile(state.compilePhase, limit);
  }, 5000);
}
function abandonCompile(phase, limit) {
  const what = phase === 'latex' ? 'el motor LaTeX' : phase === 'python' ? 'Python' : 'la preparación';
  const why = `La compilación se abandonó: ${what} llevaba más de ${Math.round(limit / 60000)} min sin avanzar. `
    + 'Vuelve a compilar; si se repite, usa «Recompilar desde cero».';
  runSeq++; // the run in flight no longer owns anything
  clearInterval(watchdog);
  watchdog = null;
  compileCancel().catch(() => {});
  interruptKernel(true).catch(() => {});
  releaseKernelLock();
  state.lastLog = `===== Avisos de Pyx =====\n[Pyx] ${why}`;
  state.lastCompileOk = false;
  state.compileReason = why;
  lastReal = { ok: false, log: state.lastLog };
  finishCompile();
}

/* What the last engine run READ (its recorder list + graphics), with each
   file's {mtime, size} as it was then. A background compile may skip the
   engine only when every one of them is still that file: a plain .tex
   chapter, a .sty, a .bib or an image edited since would otherwise never reach
   the PDF — the build copies alone cannot see them. null = unknown, so the
   engine always runs. */
let lastInputs = null;

async function inputsUnchanged() {
  if (!lastInputs || !lastInputs.paths.length) return lastInputs !== null;
  try {
    const now = await fileStamps(lastInputs.paths);
    return now.every((st, i) => st && st.mtime === lastInputs.stamps[i].mtime
      && st.size === lastInputs.stamps[i].size);
  } catch (_) {
    return false;
  }
}

/** A document that needs a second pass from a clean start (references, a
 *  table of contents, lists, a bibliography, LastPage): its first pass then
 *  skips writing a PDF nobody will see. */
const NEEDS_REFS = /\\(?:label|ref|pageref|eqref|autoref|cref|Cref|cite|tableofcontents|listof\w*|printbibliography|bibliography|newlistof|addcontentsline)\b|LastPage/;

/* The last compile that actually ran the engine: its status and its log. A
   compile that finds nothing to do reports THAT, instead of a bare "no
   changes" that wiped the Problems list and turned the status bar green over
   a document that still has errors. */
let lastReal = { ok: null, log: '' };
let lastRealGen = 0; // the request whose log `lastReal` holds

/** Free the compile slot and serve whatever was asked for meanwhile. */
function finishCompile() {
  state.compiling = false;
  state.compilePhase = null;
  state.compileFresh = false;
  compilingRoot = null;
  // Serve whatever was asked for while this one ran (see `queued`).
  if (queued !== null && !cancelRequested) {
    const wantViewer = queued;
    const wantForce = queuedForce;
    const wantFresh = queuedFresh;
    queued = null;
    queuedForce = false;
    queuedFresh = false;
    state.compileQueued = false;
    // A queued "Compilar" still runs the engine (and a queued "desde cero"
    // stays one); a queued background compile may still skip the engine
    // when nothing it reads has changed.
    compileActive(wantViewer, { force: wantForce, fresh: wantFresh });
  }
  cancelRequested = false;
}

/**
 * @param {boolean} showViewer  someone asked to SEE the result (open the viewer)
 * @param {{force?: boolean}} [opts]  force = run the engine even when nothing
 *   the PDF depends on changed. An explicit "Compilar" forces — it is the user
 *   asking for ground truth, and it also picks up an image or .sty edited
 *   outside Pyx. A save, and the follow-up of a request that arrived while a
 *   compile was running, do not: when the build is already exactly what is on
 *   screen, running LaTeX again only made the user wait twice for the same PDF.
 *
 *   fresh = rebuild from NOTHING: a new Python namespace (every cell runs), no
 *   .aux/lists/SyncTeX from earlier runs, and two passes when the document has
 *   references. That is "Recompilar desde cero" — the escape hatch, never the
 *   default. Forcing it on every "Compilar" (as 1.4.x did) made each press pay
 *   for every import, dataset and simulation again plus two or three full
 *   xelatex passes, although the dependency graph (cells) and the rerun detection in
 *   latex.rs (references, lists) already guarantee the same result
 *   incrementally — and fall back to a full run on any doubt.
 */
export async function compileActive(showViewer = true, { force = showViewer, fresh = false } = {}) {
  if (fresh) force = true;
  if (state.compiling) {
    queued = !!(queued || showViewer);
    queuedForce = queuedForce || force;
    queuedFresh = queuedFresh || fresh;
    state.compileQueued = true;
    return;
  }
  cancelRequested = false;
  let doc = activeDoc();
  if (!doc) return;

  // Claim the slot BEFORE the first await: a second request arriving while the
  // save dialog below is open must queue, not start a compile of its own.
  state.compiling = true;
  state.compilePhase = 'prep';
  state.compileFresh = fresh;
  // This run's number. `mine()` turns false if the watchdog abandons it: from
  // then on it must not touch the app's state, whatever it still has to do.
  const run = ++runSeq;
  const mine = () => run === runSeq;
  const gen = ++state.compileGen;
  // A background compile that was armed is this one, or is overtaken by it.
  cancelLiveCompile();
  startWatchdog();

  // A file must exist on disk for the engine (and relative paths) to work.
  if (!doc.path) {
    lastBeat = Infinity; // a save dialog is open: the user's time, not a stall
    const ok = await saveActiveAs().catch(() => false);
    beat();
    if (!mine()) return;
    doc = activeDoc();
    if (!ok || !doc || !doc.path) {
      clearInterval(watchdog);
      watchdog = null;
      state.compiling = false;
      state.compilePhase = null;
      state.compileFresh = false;
      queued = null; // nothing to compile until the document has a place on disk
      state.compileQueued = false;
      return;
    }
  }
  state.lastCompileOk = null;
  const t0 = performance.now();
  // Where the time actually goes, reported at the end of the log. Compiling is
  // this app's inner loop, and when it feels slow the only useful question is
  // "slow doing what" — guessing that answer has already been wrong once.
  const phase = { cells: 0, tex: 0, ran: 0, total: 0, prep: 0, build: 0 };
  // Did the ENGINE run in this compile (and for how long)? Only that feeds
  // the live-compile delay.
  let engineMs = null;
  // The detached viewer replaces the in-app pane: don't reopen it while the
  // auxiliary window is the one showing the PDF.
  if (showViewer && !auxOpen()) state.previewVisible = true;
  try {
    const content = getDocContent(doc.id);
    // Persist the SOURCE to disk on compile so the engine sees the latest —
    // but a .pltx is a ZIP container (packed only on explicit Save): writing
    // plain text to it would corrupt it, so we compile from the .build.tex and
    // leave the container untouched (stays 'modified' until the user saves).
    //
    // Only when the buffer differs from the file: a live compile fires on
    // every typing pause, and rewriting an unchanged source each time was
    // pure disk churn (and bumped its mtime for every sync tool watching it).
    if (!isPltx(doc.path) && doc.modified) {
      await saveWithEncoding(doc.path, content);
      markSavedIfUnchanged(doc, content);
    }

    // 0) Master document: compiling a child compiles its ROOT (and the whole
    //    \input tree below it). The root may be open (use its live content) or
    //    only on disk.
    const rootPath = await resolveRootPath(doc, content);
    beat();
    if (!mine()) return null;
    compilingRoot = rootPath; // which project this run is building (showSavedPdf)
    let rootDoc = doc;
    let rootContent = content;
    if (rootPath !== doc.path) {
      const open = state.documents.find((d) => !d.kind && samePath(d.path, rootPath));
      if (open) {
        rootDoc = open;
        rootContent = getDocContent(open.id);
        if (!isPltx(rootPath) && open.modified) {
          await saveWithEncoding(rootPath, rootContent);
          markSavedIfUnchanged(open, rootContent);
        }
      } else {
        rootDoc = { id: -1, path: rootPath, fileName: baseName(rootPath), engine: doc.engine };
        try { rootContent = await readSourceFile(rootPath); } catch (_) { rootContent = ''; }
      }
    }

    const cwd = dirOf(rootPath);
    const stem = stemOf(rootPath);
    let problems = '';
    let pythonNote = ''; // why the Python process was replaced, if it was
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
    beat();
    if (!mine()) return null;
    phase.prep = performance.now() - t0;
    const rootF = files.get(rootPath);
    const isPyx = rootF.isPyx;
    const pythonOnly = isPyx && !/\\documentclass|\\begin\s*\{document\}/.test(rootContent);
    const pyFiles = [...files.keys()].filter((p) => files.get(p).isPyx);
    let pyValExprs = pythonOnly ? [] : [
      ...new Set(pyFiles.flatMap((p) => files.get(p).pyExprs.map((e) => e.expr))),
    ];
    // \pyif{cond}{…}{…} conditions are evaluated as bool(cond) alongside \py{}.
    let condExprs = pythonOnly ? [] : [
      ...new Set(pyFiles.flatMap((p) => files.get(p).conds)),
    ];
    let exprs = [...pyValExprs, ...condExprs.map(pyifKey)];
    let valueMap = {};
    const nbFiles = [...files.values()].filter((f) => f.notebooks);
    const anyCells = pyFiles.some((p) => files.get(p).cells.length > 0)
      || nbFiles.some((f) => [...f.notebooks.values()].some((nb) => nb.cells.length > 0));
    // A notebook that could not be read is said, with the reason: its
    // variables are then missing, and the NameError alone would not explain why.
    let nbProblems = '';
    const nbNotes = []; // where each linked notebook's values came from (log)
    let watched = [];   // the linked files this compile used (link-watch.js)
    for (const f of nbFiles) {
      for (const nb of f.notebooks.values()) {
        if (nb.error) nbProblems += `\n[${baseName(nb.path || nb.raw)}] No se pudo leer: ${nb.error}`;
      }
    }

    if (anyCells || exprs.length) {
      /* Linked notebooks (\pynotebook): their VALUES, or their cells.
         The document takes the variables it uses from the notebook's live
         Jupyter kernel — or from the snapshot of the last ones while the
         notebook's code is unchanged — and nothing of the notebook runs.
         Only when neither exists do its cells run here (and a snapshot is
         taken from that run). See cell-runner.js resolveNotebook. */
      const docCodes = nbFiles.length ? pyFiles.flatMap((p) => files.get(p).cells.map((c) => c.code)) : [];
      const docNeeds = nbFiles.length ? documentReads(docCodes, [...pyValExprs, ...condExprs]) : null;
      const docOwn = nbFiles.length ? documentDefs(docCodes) : null;
      const nbPlans = new Map(); // notebook path -> resolveNotebook result
      /* The project's cells in EXECUTION order: document order, descending
         into each \input where it appears. gatherTree already recorded that
         order as a flat event list per file (analyzeFile), so this walks it
         directly instead of re-splitting every file of the project.
         Runs inside the kernel lock: resolving a notebook asks the kernel. */
      let runOrder = [];
      let program = [];
      let scope = { scopes: {}, captures: new Map() }; // py-scope.js
      const nbRan = new Set();   // notebooks whose cells ran in this compile
      const nbSaved = new Set(); // ... and whose values were then saved
      const nbFresh = new Map(); // notebook → names its cells that ran define
      const prepare = async (fresh) => {
        nbPlans.clear();
        for (const f of nbFiles) {
          for (const nb of f.notebooks.values()) {
            if (nbPlans.has(nb.path) || !nb.cells.length) continue;
            nbPlans.set(nb.path, await resolveNotebook(nb.path, nb.cells, docNeeds, cwd, { fresh, own: docOwn }));
          }
        }
        runOrder = [];
        const seen = new Set();
        const placed = new Set(); // a notebook linked twice takes part once, where it first appears
        const visits = []; // [path, entries before the file] — where each \py{} stands
        const walkOrder = (path) => {
          if (seen.has(path)) return;
          seen.add(path);
          const f = files.get(path);
          if (!f) return;
          visits.push([path, runOrder.length]);
          let n = 0;
          for (const ev of f.events) {
            walkEvent(path, f, ev, () => ++n);
            ev.end = runOrder.length;
          }
        };
        const walkEvent = (path, f, ev, nth) => {
          if (ev.kind === 'input') {
            const child = f.raws.get(ev.raw);
            if (child) walkOrder(child);
            return;
          }
          if (ev.kind === 'notebook') {
            // The notebook's values (one entry) or its code cells, here.
            const nb = f.notebooks && f.notebooks.get(ev.ref);
            const plan = nb && !placed.has(nb.path) && nbPlans.get(nb.path);
            if (nb) placed.add(nb.path);
            for (const e of (plan && plan.entries) || []) {
              runOrder.push({ path: nb.path, file: f, cell: e.cell, nth: e.cell.nth, notebook: true, link: e.link, info: e.info });
            }
            return;
          }
          runOrder.push({ path, file: f, cell: ev.cell, nth: nth() });
        };
        walkOrder(rootPath);
        phase.total = runOrder.filter((e) => !e.link).length;
        program = programOf(runOrder.map((e) => ({ key: execKey(e.path, null, e.cell), cell: e.cell, info: e.info })));
        // \py{x} reads the x of the nearest file or cell above it when x is
        // given more than once (py-scope.js): mark those, in a tagged copy of
        // each file's text, and re-list the expressions to evaluate.
        for (const f of files.values()) f.tagged = null;
        if (!pythonOnly) {
          const occ = visits.flatMap(([p, start]) => occurrencesOf(p, files.get(p), start));
          const sc = scopeExpressions(program, occ);
          scope = sc;
          for (const [p, list] of sc.tags) files.get(p).tagged = applyScopeTags(files.get(p).content, list);
        }
        // The expressions to evaluate are the ones the build will look up —
        // marked or not — every time (a second prepare may mark none).
        const fileOf = (p) => files.get(p).tagged || files.get(p).content;
        if (pythonOnly) return;
        pyValExprs = [...new Set(pyFiles.flatMap((p) => findPyExprs(fileOf(p)).map((e) => e.expr)))];
        condExprs = [...new Set(pyFiles.flatMap((p) => collectPyIfConds(fileOf(p))))];
        exprs = [...pyValExprs, ...condExprs.map(pyifKey)];
      };

      /* Run only the cells a change reaches.
       *
       * The dependency graph (dep-plan.js) knows what each cell defines and
       * reads, and what version of each cell the kernel's namespace reflects.
       * A compile runs the cells whose code changed, the cells that depend on
       * them — each only if what it reads really came out different (early
       * cutoff) — and nothing else. Editing the plot at the end of a report no
       * longer re-runs the simulation above it; editing a paragraph runs no
       * Python at all.
       *
       * Whatever the graph cannot follow (exec, `global`, IPython magics…)
       * falls back to the exact rule: reuse the namespace only when the
       * kernel ran exactly the first cells of this document, otherwise reset
       * and run everything. An unknown namespace is never reused, and "Recompilar
       * desde cero" always starts from an empty one. */
      // Says whether everything ran from a clean namespace, and whether a cell failed.
      const runTree = async (force) => {
        problems = '';
        phase.ran = 0; // "N ejecutadas de M" speaks of THIS run (a self-heal is a second one)
        await prepare(force);
        if (!force) await ensureStarNames(program, cwd);
        let plan = force ? null : nsPlan(program, { dir: cwd });
        if (plan && plan.mode !== 'full') {
          const mustRun = (i) => (plan.seeds ? plan.seeds.has(i) : plan.run.includes(i));
          const forced = [];
          // A handcalcs cell that is skipped must have its typeset block on
          // hand, or the PDF would silently lose the calculation. Every run
          // fills the cache; this only fires after an eviction.
          program.forEach((p, i) => {
            if (!mustRun(i) && !runOrder[i].notebook && HANDCALCS_MAGIC.test(runOrder[i].cell.code)
              && !renderKnown(p.hash)) forced.push(p.key);
          });
          // A cell is only "already run" if what it READ is still the same: a
          // spreadsheet or CSV edited since gives different numbers with the
          // same code. That cell runs again, with what depends on it.
          const deps = nsReads(program.filter((_, i) => !mustRun(i)).map((p) => p.key));
          if (deps.length) {
            try {
              const st = await fileStamps(deps.map((d) => d.path));
              st.forEach((x, i) => {
                if (!x || x.mtime !== deps[i].mtime || x.size !== deps[i].size) forced.push(deps[i].key);
              });
            } catch (_) {
              plan = null;
            }
          }
          // An entry whose copy of what it gave a name is missing (a \py{}
          // between two definers needs it): run it once more to keep it.
          for (const k of scope.captures.keys()) if (!scopeCurrent(k)) forced.push(k);
          if (plan && forced.length) plan = nsPlan(program, { dir: cwd, forced });
        }
        let fromScratch = false;
        if (!plan || plan.mode === 'full') {
          await runCellCode('', { cwd, reset: true });
          const why = takeRestartReason();
          if (why) pythonNote = `proceso nuevo: el documento modificaba ${why.join(', ')}`;
          plan = nsPlan(program, { dir: cwd });
          fromScratch = true;
        }
        const out = await executePlan(plan, {
          stop: () => cancelRequested, // "Detener": not one more cell
          forget: forgetNames,
          run: async (i, watch) => {
            beat(); // a cell starting is progress
            const { path, cell, nth, notebook, link } = runOrder[i];
            if (link) {
              // A notebook's values: loaded, not computed (nothing of it runs).
              const res = await runLinkEntry(runOrder[i], cwd, { key: program[i].key, D: plan.effects[i].D });
              if (res.stderr) cellProblem(`${baseName(path)} · valores`, res.stderr);
              return res;
            }
            phase.ran++;
            if (notebook) {
              nbRan.add(path);
              // What it (re)defines: only these are pickled again on save.
              if (!nbFresh.has(path)) nbFresh.set(path, new Set());
              for (const d of plan.effects[i].D || []) nbFresh.get(path).add(d);
            }
            const od = notebook ? null : state.documents.find((d) => !d.kind && samePath(d.path, path));
            const view = od ? getViewOfDoc(od.id) : null;
            // A notebook's cells run from the notebook's folder, as in Jupyter.
            const res = await execCellFor(view, view ? docIdOf(view.state) : null, cell, cwd,
              { key: program[i].key, D: plan.effects[i].D, watch, runCwd: notebook ? cell.dir : undefined });
            // execCellFor recorded the cell's typeset block (recordRender, where
            // the HARD RULE lives: only a cell that EXPLICITLY declares
            // %%render / %%tex may put anything into the PDF).
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
            } else {
              const keep = new Set(scope.captures.get(program[i].key) || []);
              // A linked file run here: what its cell gave the file's names,
              // NOW — a file linked further down may give them other values
              // before its snapshot is taken (saveNotebookValues).
              const nbp = notebook ? nbPlans.get(path) : null;
              if (nbp && nbp.mode === 'run') {
                const want = new Set([...(nbp.names || []), ...(nbp.extras || [])]);
                for (const d of program[i].info.defs) if (want.has(d)) keep.add(d);
              }
              if (keep.size) await captureScope(program[i].key, [...keep], cwd);
            }
            return res;
          },
        });
        // Everything a failed cell feeds would run against a namespace we can
        // no longer describe: it stops there, and what did not run is marked
        // outdated so the next compile runs it.
        if (!out.ok) nsMarkStale(out.notRun.map((i) => program[i].key));
        // A notebook whose cells had to run here: its values are saved now,
        // so the next compile (or the next session) loads them instead.
        for (const [nbPath, nbPlan] of nbPlans) {
          if (nbPlan.mode === 'run' && nbRan.has(nbPath) && !cancelRequested && nsHasRun(nbPlan.entries)) {
            const saved = await saveNotebookValues(nbPath, nbPlan, cwd, (nbPlan.restored || nbPlan.ranHere) ? nbFresh.get(nbPath) : null);
            if (saved && saved.saved) nbSaved.add(nbPath);
          }
        }
        // Every cell contributes its typeset block, skipped ones included:
        // their code is unchanged, so the cached render is exactly current.
        for (const f of files.values()) f.renders = {};
        for (const { file, cell, notebook } of runOrder) {
          if (notebook) continue; // a notebook's handcalcs stay in the notebook
          const latex = cachedRender(cell.codeHash);
          if (latex) file.renders[cellKey(cell)] = latex;
        }
        return { fromScratch, failed: out.failedAt !== undefined };
      };

      // ONE lock for the whole sequence: reset + every cell + \py{} evaluation
      // run atomically — a manual Shift+Enter can never mutate the namespace
      // between running the cells and reading the values for the document.
      const tCells = performance.now();
      state.compilePhase = 'python';
      await withKernelLock(async () => {
        // Only "Recompilar desde cero" discards what the kernel holds; any
        // other compile reuses what the dependency graph proves current.
        const { fromScratch, failed } = await runTree(fresh);

        // 2) Resolve \py{...} expressions against that exact namespace.
        if (exprs.length && !cancelRequested) valueMap = await evalExpressions(exprs, { cwd, scopes: scope.scopes });

        // Self-heal: if an incremental run met a namespace that had drifted
        // (the kernel was restarted between compiles, a cell was interrupted),
        // rerun everything once inside the same lock.
        //
        // This is the ONLY thing standing between an incremental run and a
        // wrong number, and it is enough: a namespace that no longer holds
        // what the document expects shows up as a \py{} that fails to
        // evaluate, and that triggers the full re-run right here, before
        // anything reaches the PDF.
        //
        // Only when cells were SKIPPED, though. After a run that started from
        // an empty namespace there is nothing to heal: a \py{} that fails
        // there fails because of what it says — a typo, a division by zero, a
        // cell that errored or was interrupted — and running every cell a
        // second time cannot change that. It did exactly that, doubling the
        // work of every compile with a broken \py{} (and turning one
        // interrupted 30-second cell into sixty), and the log said "2
        // ejecutadas de 1".
        // Never after "Detener": the stop interrupted a cell, and healing
        // would re-run every cell the user just asked to stop. Nor after a
        // cell failed: the values it should have produced are missing because
        // of that cell, and running everything again cannot change it.
        if (!cancelRequested && !fromScratch && !failed && exprs.some((x) => valueMap[x] && !valueMap[x].ok)) {
          await runTree(true);
          if (exprs.length) valueMap = await evalExpressions(exprs, { cwd, scopes: scope.scopes });
        }
      });
      phase.cells = performance.now() - tCells;
      beat();
      if (!mine()) return null;
      state.compilePhase = 'prep';
      for (const [nbPath, nbPlan] of nbPlans) {
        const note = notebookNote(nbPath, nbPlan, nbRan.has(nbPath));
        if (note) nbNotes.push(note);
        const name = baseName(nbPath);
        if (nbPlan.missing && nbPlan.missing.length) {
          nbProblems += nbPlan.source === 'jupyter'
            ? `\n[${name}] Jupyter no tiene ${nbPlan.missing.join(', ')}: ejecuta en Jupyter las celdas que las definen.`
            : `\n[${name}] Los valores guardados no incluyen ${nbPlan.missing.join(', ')}.`;
        }
        const bad = Object.entries(nbPlan.errors || {}).filter(([n]) => (nbPlan.asked || []).includes(n));
        if (bad.length) {
          nbProblems += `\n[${name}] No se pudieron copiar del cuaderno: ${bad.map(([n, e]) => `${n} (${e})`).join('; ')}`;
        }
        // (A notebook that FAILED is not saved, on purpose: its error is listed.)
        if (nbRan.has(nbPath) && nbPlan.mode === 'run' && !nbSaved.has(nbPath) && nbPlan.names && nbPlan.names.length
          && nsHasRun(nbPlan.entries)) {
          nbNotes.push(`${name}: no se pudieron guardar sus valores; la próxima vez se tomarán de Jupyter si está abierto`);
        }
      }
      // What went wrong around a notebook without stopping the compile
      // (values not saved, a snapshot that could not be put back).
      for (const p of takeLinkProblems()) nbNotes.push(`Aviso: ${p}`);
      // From here on these files are watched (link-watch.js): run in Jupyter
      // or saved from another editor, they reach the PDF without typing here.
      watched = [...nbPlans].map(([path, p]) => ({
        path, needed: docNeeds, cwd, codeHash: p.codeHash, linked: p.mode === 'link',
      }));
    }
    setLinkWatch(watched);
    problems += nbProblems;

    // The editor's ghost value of a \py{} that reads the value of the file or
    // cell above it shows THAT value, as the PDF does (py-ghost.js).
    for (const [p, f] of files) {
      const od = state.documents.find((d) => !d.kind && samePath(d.path, p));
      const key = od ? od.path : p;
      if (!f.tagged) { setScopedValues(key, []); continue; }
      const orig = findPyExprs(f.content);
      const tagged = findPyExprs(f.tagged);
      const count = new Map();
      const list = [];
      orig.forEach((o, i) => {
        const n = count.get(o.expr) || 0;
        count.set(o.expr, n + 1);
        const t = tagged[i];
        if (t && t.expr !== o.expr && valueMap[t.expr]) list.push({ expr: o.expr, ordinal: n, value: valueMap[t.expr] });
      });
      setScopedValues(key, list);
      const v = od ? getViewOfDoc(od.id) : null;
      if (v) refreshGhostIn(v);
    }

    if (cancelRequested) {
      state.lastLog = '===== Avisos de Pyx =====\n[Pyx] Compilación detenida por el usuario.';
      state.lastCompileOk = false;
      state.compileReason = 'Compilación detenida por el usuario.';
      return null;
    }
    // Python-only .pltx (no LaTeX document): running the cells IS the compile.
    if (pythonOnly) {
      state.lastLog =
        (problems ? `===== Avisos de Pyx =====${problems}\n\n` : '') +
        'Documento sin LaTeX: se han ejecutado las celdas Python (no se genera PDF).'
        + (nbNotes.length ? `\n\nArchivos vinculados:\n${nbNotes.map((n) => `  ${n}`).join('\n')}` : '');
      state.lastCompileOk = !problems;
      state.compileReason = '';
      return;
    }

    for (const e of pyValExprs) {
      if (valueMap[e] && !valueMap[e].ok) problems += `\n[\\py{${stripScopeTag(e)}}] ${valueMap[e].value}`;
    }
    for (const c of condExprs) {
      const v = valueMap[pyifKey(c)];
      if (v && !v.ok) problems += `\n[\\pyif{${stripScopeTag(c)}}] ${v.value}`;
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
      // A file whose \input points at an unreadable chapter needs its own
      // copy, with that \input replaced — the original would feed the engine
      // the damaged file.
      let n = f.needsBuild || !!(f.unreadable && f.unreadable.size);
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
    const use = {
      envs: new Set(), styles: new Set(), usesPy: false, usesGraphics: false, usesRender: false,
    };
    for (const [path, f] of files) {
      for (const e of f.verbEnvs) use.envs.add(e);
      for (const s of f.verbStyles) use.styles.add(s);
      if (f.usesPy) use.usesPy = true;
      if (f.usesGraphics) use.usesGraphics = true;
      // Whether any cell asks handcalcs to typeset it (its blocks need amsmath).
      if (!use.usesRender && f.cells.some((c) => HANDCALCS_MAGIC.test(c.code))) {
        use.usesRender = true;
      }
      if (f.unterminated) {
        problems += `\n[${baseName(path)} · línea ${f.unterminated}] celda sin %#end:`
          + ' no se ejecuta y el resto del archivo no llega al PDF.';
      }
      for (const [raw, why] of f.unreadable || []) {
        problems += `\n[${baseName(path)}] no se pudo leer \\input{${raw}}`
          + `${why ? ` (${why})` : ''}: en el PDF aparece «No se pudo leer» en su lugar.`;
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
    const tBuild = performance.now();
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
    const buildFileOf = (p) => joinPath(outDir, buildRel.get(p));
    const building = [...files.keys()].filter((p) => p === rootPath || needs.get(p));
    const onDisk = new Map(); // ONE round-trip for the whole project
    try {
      const st = await fileStamps(building.map(buildFileOf));
      building.forEach((p, i) => onDisk.set(buildFileOf(p), st[i]));
    } catch (_) { /* no stamps: everything is rewritten, which is always correct */ }
    const written = [];
    for (const [path, f] of files) {
      if (path !== rootPath && !needs.get(path)) continue;
      let processed = f.content;
      const buildFile = joinPath(outDir, buildRel.get(path));
      const mapKey = baseName(buildFile).toLowerCase();
      if (f.isPyx) {
        // The build is CLEAN LaTeX (cells removed, \py{} substituted): it
        // compiles standalone in TeXstudio. Removing lines shifts everything
        // below a cell, so keep the build↔source map for SyncTeX and the log.
        const neut = neutralizeCells(f.tagged || f.content, f.renders);
        processed = resolvePyText(resolvePyIf(neut.text, valueMap), valueMap);
        if (neut.srcLines) lineMaps[mapKey] = neut.srcLines;
      }
      /* A \py{} the build still carries.
       *
       * In a file Pyx processes it means the value could not be substituted —
       * an incident to report, silenced on the page by the preamble's guard.
       * In a plain .tex (no cells: pure LaTeX by the per-file rule) it is
       * simply not Pyx's to resolve, and the guard prints nothing, as before.
       *
       * Either way, one whose braces do NOT close has to go: the guard would
       * eat an argument that never ends and take the whole document with it
       * ("Emergency stop", no PDF). That check used to live inside the
       * processed-file branch, so a plain .tex with a broken \py{} still lost
       * its whole compile. */
      const leaks = findPyxLeaks(processed);
      for (const lk of leaks) {
        if (!f.isPyx && lk.balanced) continue; // not this file's business
        const src = buildToSrcLine(lineMaps[mapKey], lk.line);
        problems += `\n[${baseName(path)} · línea ${src}] ${lk.token} `
          + (lk.balanced
            ? 'sin resolver: no se imprimirá nada en el PDF.'
            : 'con las llaves sin cerrar: se ignora el comando y se compila el resto.');
      }
      processed = defusePyxLeaks(processed, leaks.filter((lk) => !lk.balanced));
      processed = processed.replace(new RegExp(INPUT_SRC, 'g'), (all, cmd, raw) => {
        if (f.unreadable && f.unreadable.has(raw)) {
          return `\\fbox{\\normalfont\\ttfamily\\small No se pudo leer: \\detokenize{${raw}}}`;
        }
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
      const rec = lastBuildWritten.get(buildFile);
      const disk = onDisk.get(buildFile);
      if (!fresh && rec && rec.fp === stampNow && disk && disk.mtime >= 0
        && disk.mtime === rec.mtime && disk.size === rec.size) continue;
      // The working directory mirrors the project's folders; create the branch
      // the first time a chapter in a subfolder is written.
      const parent = dirOf(buildFile);
      if (parent && parent !== outDir) await createDir(parent).catch(() => {});
      await writeTextFile(buildFile, processed);
      lastBuildWritten.set(buildFile, { fp: stampNow });
      written.push(buildFile);
      wroteAny = true;
    }
    // Record what we wrote AS IT NOW IS ON DISK, again in one round-trip. A
    // record without a stamp never matches, so a failure here only costs a
    // rewrite next time.
    if (written.length) {
      try {
        const st = await fileStamps(written);
        written.forEach((b, i) => Object.assign(lastBuildWritten.get(b), st[i]));
      } catch (_) { /* unstamped → rewritten next compile */ }
    }
    const buildPath = joinPath(outDir, buildRel.get(rootPath));
    phase.build = performance.now() - tBuild;
    beat();
    if (!mine()) return null;

    // Published for forward/inverse SyncTeX and the log parser — keyed by the
    // build file's lowercase basename. These are plain data (arrays of tens of
    // thousands of integers) that nothing renders, so they live outside the
    // reactive store: behind a Proxy, every lookup paid a trap.
    const buildMapData = {
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
      // build path (relative to the working directory) -> real source path:
      // what SyncTeX reports is matched by its FULL relative path, so two
      // chapters with the same name in different folders cannot be confused.
      files: Object.fromEntries([...files.keys()]
        .filter((p) => p === rootPath || needs.get(p))
        .map((p) => [buildRel.get(p), p])),
    };
    setBuildMaps(buildMapData);
    // …and on disk, next to the PDF: Ctrl+click works right after opening a
    // document, before this session has compiled it.
    persistBuildMaps(buildMapData).catch(() => {});

    // ONE pass. The engine asks for more when it needs them, and the backend
    // listens: labels that moved ("Rerun to get cross-references right"), a
    // listing that did not exist yet, or a .toc/.lof/.lot whose content this
    // pass changed — which LaTeX never warns about (see latex.rs).
    //
    // This used to force TWO passes whenever the text merely contained \ref,
    // \cite or \tableofcontents: nearly every real document, on every compile,
    // although the .aux is kept between compiles and the references are
    // already settled. With xelatex, which has no draft mode, that was a
    // second full typesetting of the whole document almost every time.
    const usesRefs = [...files.values()].some((f) => NEEDS_REFS.test(f.content));
    // From scratch the .aux is gone, so references need a second pass up
    // front; otherwise the kept .aux settles them and latex.rs adds a pass
    // only when TeX asks for one.
    const passes = fresh && usesRefs ? 2 : 1;
    // % !TeX program = pdflatex — the document names its own engine, like in
    // TeXstudio. An explicit per-document choice (Configuración) still wins.
    const magicEngine = (
      /^\s*%\s*!TeX\s+(?:TS-)?program\s*=\s*(pdflatex|xelatex|lualatex|tectonic)\s*$/im.exec(rootContent)
      || []
    )[1];
    const engine = rootDoc.engine || doc.engine || (magicEngine || '').toLowerCase()
      || state.env.latex || 'xelatex';

    // Nothing the engine reads changed: running it again would burn seconds to
    // produce the same bytes. Skipped ONLY when all of this holds —
    //  - a background compile (a MANUAL one always runs: it is the user asking
    //    for ground truth, and it also picks up an image or .sty edited outside);
    //  - no build file had to be (re)written, checked against the disk;
    //  - no cell ran: a cell can rewrite a figure the text merely points at,
    //    and the build text of `\includegraphics{xref/f.png}` does not change
    //    when f.png does;
    //  - the viewer is showing THIS document's PDF — after switching to another
    //    project, "nothing changed" is not a reason to keep someone else's.
    const expectedPdf = joinPath(outDir, `${stem}.pdf`);
    if (!force && !wroteAny && phase.ran === 0
      && samePath(lastPdfPath, expectedPdf) && await pathExists(lastPdfPath)
      && await inputsUnchanged()) {
      state.lastLog = (problems ? `===== Avisos de Pyx =====${problems}\n\n` : '')
        + (lastReal.log || 'Sin cambios que afecten al PDF: no se ha recompilado.');
      state.lastCompileOk = problems ? false : (lastReal.ok ?? true);
      state.compileReason = '';
      if (showViewer && !auxOpen() && !samePath(getPdfPath(), expectedPdf)) {
        markPdfForeign(false);
        showCompiledPdf(expectedPdf, { gen, follow: false });
      }
      return null;
    }

    // The folder of every file in the tree, so an image or .sty beside a
    // chapter in a subfolder resolves (behind the project folder; latex.rs).
    const searchDirs = [...new Set([...files.keys()].map(dirOf))].filter((d) => !samePath(d, cwd));

    const tTex = performance.now();
    // "Recompilar desde cero" starts the engine from nothing as well: no
    // .aux, no lists, no SyncTeX index from earlier runs. Any other compile
    // keeps them — that is what lets most compiles finish in ONE pass.
    // (A damaged .aux from an interrupted run is cleaned by latex.rs anyway.)
    state.compilePhase = 'latex';
    beat();
    // The engine left paused after the last compile (preamble already typeset)
    // runs BACKGROUND compiles only. One the user asked for — "Compilar" — is
    // the ground truth: a fresh engine from the first line, as TeXstudio would
    // run it. Either kind leaves the next engine paused, for the typing that
    // follows.
    const warmOn = general.warmEngine !== false;
    const res = await compileLatex(buildPath, cwd, engine, passes, stem, searchDirs, fresh,
      warmOn && !force, warmOn, gen);
    phase.tex = performance.now() - tTex;
    engineMs = phase.tex;
    beat();
    if (!mine()) return null;
    // Remember what this run read, to know next time whether it may be
    // skipped. A file changed WHILE it ran may not be in this PDF: then the
    // next compile must run.
    lastInputs = null;
    if (!res.stopped && Array.isArray(res.inputs)) {
      try {
        const st = res.inputs.length ? await fileStamps(res.inputs) : [];
        if (st.every((x) => x && x.mtime >= 0 && x.mtime < (res.started_ms || 0))) {
          lastInputs = { paths: res.inputs, stamps: st };
        }
      } catch (_) { /* unknown → never skipped */ }
    }
    if (res.stopped) {
      problems += res.stopped === 'cancelado'
        ? '\n[LaTeX] Compilación detenida por el usuario.'
        : res.stopped === 'sustituida'
          ? '\n[LaTeX] Sustituida por una compilación más reciente.'
          : '\n[LaTeX] Pyx detuvo el motor: '
            + (res.stopped === 'bucle' ? 'el mismo error se repetía sin fin (bucle).'
              : res.stopped === 'sin-progreso' ? 'llevaba demasiado tiempo sin avanzar (bucle infinito).'
                : 'superó el tiempo máximo de una pasada.')
            + ' Detalles al final del registro.';
    }
    // A compile ends in a new PDF or in a reason — never in "done" over the
    // PDF of an hour ago. latex.rs always gives one when it wrote no PDF.
    const reason = res.pdf_path ? '' : (res.reason || 'El motor terminó sin escribir un PDF.');
    state.compileReason = reason;
    // What the engine actually did: the backend adds passes when TeX needs them.
    const ranPasses = ((res.log || '').match(/===== Pasada /g) || []).length || passes;
    // The engine died writing the PDF (latex.rs explains why and names any
    // missing image): list it as a problem, not only deep in the raw log.
    const cut = /===== Pyx: el PDF no se completó =====\n([\s\S]*?)(?:\n=====|$)/.exec(res.log || '');
    if (cut) problems += `\n[PDF] ${cut[1].trim().replace(/\s*\n\s*/g, ' ')}`;
    else if (reason && !res.stopped) problems += `\n[PDF] No hay PDF nuevo: ${reason.replace(/\s*\n\s*/g, ' ')}`;
    const tm = res.timings || {};
    const passesMs = (tm.passes_ms || []).map((x) => `${x} ms`).join(' + ');

    state.lastLog =
      (problems ? `===== Avisos de Pyx =====${problems}\n\n` : '') + (res.log || '')
      + `\n\n===== Tiempos de Pyx =====\n`
      + `Celdas Python : ${Math.round(phase.cells)} ms `
      + `(${phase.ran} ejecutada${phase.ran === 1 ? '' : 's'} de ${phase.total})\n`
      + `Motor LaTeX   : ${Math.round(phase.tex)} ms `
      + `(${engine}, ${ranPasses} pasada${ranPasses === 1 ? '' : 's'}`
      + `${tm.warm ? ', preámbulo ya cargado' : ''})\n`
      + (passesMs ? `  pasadas     : ${passesMs}`
        + `${tm.tools_ms ? `; bibliografía e índices ${tm.tools_ms} ms` : ''}`
        + `; antes ${tm.prep_ms || 0} ms; PDF y lista de archivos ${tm.finish_ms || 0} ms`
        + `${tm.wait_ms > 20 ? `; en espera ${tm.wait_ms} ms` : ''}\n` : '')
      + `Preparación   : ${Math.round(phase.prep)} ms leer el proyecto, ${Math.round(phase.build)} ms escribir las copias\n`
      + `Total         : ${Math.round(performance.now() - t0)} ms`
      + (fresh ? '\nModo          : desde cero (kernel nuevo, sin datos auxiliares)' : '')
      + (pythonNote ? `\nPython        : ${pythonNote}` : '')
      + nbNotes.map((n) => `\nVinculado     : ${n}`).join('');
    // Three outcomes, not two. A PDF that LaTeX produced while recovering from
    // errors is not a failed compile — the document IS there, with its
    // problems listed — and painting it with the same red as "no PDF at all"
    // is what sent people pressing compile again and again.
    state.lastCompileOk = res.ok ? true : (res.pdf_path ? 'warn' : false);
    lastReal = { ok: state.lastCompileOk, log: state.lastLog };
    lastRealGen = gen;

    // TeXstudio-style: pdf_path is only set when THIS run wrote a PDF, so show
    // it even if TeX recovered from errors — they stay listed in the log panel.
    if (res.pdf_path) {
      lastPdfPath = res.pdf_path;
      state.lastPdfPath = res.pdf_path; // forward search reads this
      // Did the user move to a DIFFERENT project while this ran? Then the
      // viewer is showing that one, and this PDF must not take it over; it is
      // on disk, and coming back to this document brings it up (switchTo).
      const now = activeDoc();
      if (now && !now.kind && now.path && now.id !== doc.id) {
        const nowRoot = await resolveRootPath(now, getDocContent(now.id)).catch(() => null);
        if (nowRoot && !samePath(nowRoot, rootPath)) return res;
      }
      // This PDF IS the active document's: whatever warning was up is stale.
      markPdfForeign(false);
      // The compile is done. Showing its PDF is the viewer's business and
      // holds nothing back (see showCompiledPdf).
      showCompiledPdf(res.pdf_path, { gen, follow: !showViewer });
    }
    // Never force the log open: compilation is silent unless the user opens it.
    return res;
  } catch (e) {
    if (!mine()) return null;
    // In the "Avisos de Pyx" shape, so the Problems view LISTS the failure. A
    // bare message there read "✓ Sin errores ni avisos detectados" under a
    // status bar that said the compile had failed.
    const why = String((e && e.message) || e);
    state.lastLog = `===== Avisos de Pyx =====\n[Pyx] ${why}`;
    state.lastCompileOk = false;
    state.compileReason = why;
  } finally {
    // Abandoned by the watchdog: the slot was freed there, and may already
    // belong to another compile.
    if (mine()) {
      clearInterval(watchdog);
      watchdog = null;
      // Only the engine's own time stretches the wait before the next
      // background compile — and only when the engine ran.
      if (engineMs != null) lastEngineMs = engineMs;
      state.compileMs = Math.round(performance.now() - t0);
      state.liveSuspended = false;
      finishCompile();
    }
  }
}
