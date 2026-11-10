// Jupyter notebooks linked to a document: `\pynotebook{ruta/al/cuaderno.ipynb}`.
//
// The notebook's variables enter Pyx's namespace AT THAT POINT of the
// document — so `\py{L}`, `\pyif{…}` and the document's %#python cells see
// them with the same syntax as always — WITHOUT running the notebook:
//   1. from the notebook's live Jupyter kernel (VS Code, JupyterLab), where
//      the user already ran it: the values are copied, nothing executes;
//   2. else from the snapshot of the last values, while the notebook's code
//      is the same as when they were taken;
//   3. only when neither exists do its code cells run here — once: their
//      values are then saved as the snapshot.
// (cell-runner.js resolveNotebook, kernel.py _nb_fetch.)
//
// As in Jupyter, a notebook's cells that do run here run with ITS folder as
// the working directory (`pd.read_csv("datos.csv")` next to it keeps working).

import { readNotebook, readTextFile, fileStamps } from '../core/platform.js';
import { joinPath, dirOf, normalizePath, samePath } from '../core/paths.js';
import { hashString } from '../core/hash.js';
import { createVerbatimTracker, stripTexComment } from '../compile/latex-bridge.js';
import { analyzePython } from './py-deps.js';
import { isBuiltin } from './dep-plan.js';

/* ---------- taking the VALUES instead of running the code ----------
   A notebook already run in Jupyter holds its results in that kernel: the
   document takes the variables it uses from there (or from the snapshot of
   the last values, while the notebook's code is the same) — nothing of the
   notebook runs. cell-runner.js resolveNotebook decides; these helpers say
   what the document needs and what the notebook provides. */

/** One fingerprint for the notebook's code (what its values came from). */
export function notebookCodeHash(cells) {
  return hashString(cells.map((c) => c.codeHash).join('|'));
}

/** Names the notebook's code defines, read statically; null when a cell
 *  cannot be followed (then every name the document reads is asked for). */
export function notebookDefs(cells) {
  const out = new Set();
  for (const c of cells) {
    const info = analyzePython(c.code);
    if (info.opaque || (info.stars && info.stars.length)) return null;
    for (const d of info.defs) out.add(d);
  }
  return out;
}

/** Free names the document's own cells and its \py{} / \pyif{} expressions
 *  read; null when a cell cannot be followed (exec(), import *…). A cell with
 *  a syntax error counts as reading every identifier it mentions. */
export function documentReads(codes, exprs) {
  const out = new Set();
  for (const code of codes) {
    const info = analyzePython(code);
    if (info.opaque === 'error de sintaxis') {
      // A half-typed cell (live compile runs between keystrokes) cannot be
      // followed, but it is no reason to give up and run the whole notebook:
      // whatever it reads is among the identifiers it mentions.
      for (const m of String(code).matchAll(/[\p{L}_][\p{L}\p{N}_]*/gu)) out.add(m[0]);
      continue;
    }
    if (info.opaque) return null;
    for (const r of info.reads) out.add(r);
    for (const m of info.muts) if (m && m.root) out.add(m.root);
  }
  for (const e of exprs) for (const r of analyzePython(String(e)).reads) out.add(r);
  for (const r of out) if (isBuiltin(r)) out.delete(r);
  return out;
}

/** Names the document's own cells define. */
export function documentDefs(codes) {
  const out = new Set();
  for (const code of codes) for (const d of analyzePython(code).defs) out.add(d);
  return out;
}

/** What the planner sees for "the notebook's values": a cell that defines
 *  exactly those names and reads nothing. `modules` maps the names that are
 *  modules to the module (np → "numpy"): to the planner they are imports, the
 *  same object as the document's own `import numpy as np`. */
export function linkInfo(names, modules = new Map()) {
  const binds = new Map();
  const plain = new Set();
  for (const n of names) {
    if (modules.has(n)) binds.set(n, modules.get(n));
    else plain.add(n);
  }
  return {
    defs: new Set(names), reads: new Set(), imports: new Map(), muts: [], fns: new Map(), opaque: false,
    binds, plain, stars: [],
  };
}

/* \pynotebook{…} and \pyfile{…} are the same command: a Jupyter notebook
   (.ipynb) or a Python script (.py) whose variables the document uses. */
export const LINK_CMD_SRC = '\\\\py(?:notebook|file)\\s*\\{([^}]+)\\}';
const CMD = new RegExp(LINK_CMD_SRC, 'g');
const HAS_CMD = /\\py(?:notebook|file)\b/;
/** Does this text call \pynotebook / \pyfile at all (cheap pre-check)? */
export const hasLinkCmd = (text) => HAS_CMD.test(text || '');

/** The \pynotebook{…} / \pyfile{…} calls of a LaTeX text, outside comments,
 *  verbatim and Python cells: [{ raw, line }] (1-based line). */
export function notebookRefs(text) {
  const out = [];
  if (!text || !HAS_CMD.test(text)) return out;
  const inVerb = createVerbatimTracker();
  let inCell = false;
  let ln = 0;
  for (const line of text.split(/\r?\n/)) {
    ln++;
    const t = line.trim();
    if (inCell) { if (t.startsWith('%#end')) inCell = false; continue; }
    if (inVerb(line)) continue;
    if (t.startsWith('%#python')) { inCell = true; continue; }
    if (!HAS_CMD.test(line)) continue;
    const code = stripTexComment(line);
    CMD.lastIndex = 0;
    let m;
    while ((m = CMD.exec(code))) {
      out.push({ raw: m[1].trim(), line: ln, cmd: /^\\pyfile/.test(m[0]) ? 'pyfile' : 'pynotebook' });
    }
  }
  return out;
}

const ABS_PATH = /^([a-zA-Z]:[\\/]|[\\/])/;
const HAS_EXT = /\.(ipynb|py)$/i;
/* What a name without extension means: \pyfile{datos} is a script, anything
   else a notebook. */
const defaultExt = (cmd) => (cmd === 'pyfile' ? '.py' : '.ipynb');

/** The file a \pynotebook / \pyfile argument names: relative to the ROOT
 *  document's folder (like \input); without extension, `.ipynb` for
 *  \pynotebook and `.py` for \pyfile (`cmd`). null for a relative path with no
 *  folder to resolve it from (an unsaved document).
 *
 *  The result is NORMALIZED (`./a`, `calc/../a`, mixed separators give one
 *  spelling): this string is the key of the run ledger, of the kernel's scopes
 *  and of the cell cache, and two spellings of one file used to be two
 *  notebooks — values executed twice, or reported as missing. */
export function notebookPath(rootDir, raw, cmd) {
  let r = String(raw || '').trim();
  if (!HAS_EXT.test(r)) r += defaultExt(cmd);
  if (ABS_PATH.test(r)) return normalizePath(r);
  return rootDir ? normalizePath(joinPath(rootDir, r)) : null;
}

/** Every place a \pynotebook / \pyfile argument may name, best first: the
 *  root document's folder, then the folder of the file that holds the command
 *  (a chapter in a subfolder); without extension, the command's own kind
 *  first and the other one after. */
export function linkCandidates(rootDir, raw, cmd, ownDir = null) {
  const r = String(raw || '').trim();
  if (!r) return [];
  const names = HAS_EXT.test(r)
    ? [r]
    : [r + defaultExt(cmd), r + (cmd === 'pyfile' ? '.ipynb' : '.py')];
  const dirs = ABS_PATH.test(r) ? [null] : [rootDir, ownDir].filter(Boolean);
  const out = [];
  for (const d of dirs) {
    for (const n of names) {
      const p = normalizePath(d ? joinPath(d, n) : n);
      if (!out.some((o) => samePath(o, p))) out.push(p);
    }
  }
  return out;
}

/** The file a link command names, chosen the SAME way by the compiler, by
 *  Shift+Enter, by Ctrl+click and by autocompletion: the first candidate that
 *  exists, or the first one (for the «no se encuentra» message) when none
 *  does. null when there is nothing to resolve against. */
export async function resolveLinkPath(rootDir, raw, cmd, ownDir = null) {
  const cands = linkCandidates(rootDir, raw, cmd, ownDir);
  if (cands.length < 2) return cands[0] || null;
  let stamps = null;
  try { stamps = await fileStamps(cands); } catch (_) { /* no desktop: the first one */ }
  const i = (stamps || []).findIndex((st) => st && st.mtime >= 0);
  return cands[i >= 0 ? i : 0];
}

/** A Python script (`\pyfile{calculos.py}`), not a notebook. */
export const isPyScript = (path) => /\.py$/i.test(String(path || ''));

/* A script's cells: the `# %%` markers VS Code, Spyder, PyCharm and Jupytext
   use (`#%%`, `# %% Título`, `# In[3]:` too) — or the whole file as one cell
   when it has none. A `# %% [markdown]` cell is prose in comments: skipped.
   Same shape as readNotebook's cells ({ source, id }). */
const PY_CELL = /^\s*#\s*(?:%%|In\s*\[[^\]]*\]\s*:)(.*)$/;
export function splitPyCells(text) {
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/);
  const out = [];
  let cur = [];
  let markdown = false;
  // A cell is identified by its CONTENT (plus a counter for repeats), not by
  // its position: inserting a cell at the top of the script used to rename
  // every cell after it, and all of them ran again.
  const seen = new Map();
  const flush = () => {
    if (!markdown) {
      const source = cur.join('\n');
      const h = hashString(source.trim());
      const k = (seen.get(h) || 0) + 1;
      seen.set(h, k);
      out.push({ source, id: k > 1 ? `py-${h}-${k}` : `py-${h}` });
    }
    cur = [];
  };
  let started = false;
  for (const line of lines) {
    const m = PY_CELL.exec(line);
    if (m) {
      if (started || cur.some((l) => l.trim())) flush();
      started = true;
      markdown = /\[\s*(markdown|md|raw)\s*\]/i.test(m[1]);
      continue;
    }
    cur.push(line);
  }
  flush();
  return out;
}

const cache = new Map(); // path -> { mtime, size, cells }

/** The version of the file the cells last handed out came from, as
 *  "mtime:size" (null: never read). The watcher (link-watch.js) compares the
 *  disk against THIS — what the last compile actually used. */
export function notebookStamp(path) {
  const hit = cache.get(path);
  return hit ? `${hit.mtime}:${hit.size}` : null;
}

/**
 * The notebook's code cells as Pyx cells, read again only when the file
 * changed on disk. Each cell: { code, codeHash, id, index, nth, headerLn: 0,
 * notebook: path, dir: the notebook's folder }. Throws with the reason when
 * the notebook cannot be read.
 */
export async function loadNotebook(path) {
  let [st] = await fileStamps([path]);
  const isPy = isPyScript(path);
  if (!st || st.mtime < 0) throw new Error(`no se encuentra ${isPy ? 'el archivo' : 'el cuaderno'} ${path}`);
  const hit = cache.get(path);
  if (hit && hit.mtime === st.mtime && hit.size === st.size) return hit.cells;
  let raw;
  if (isPy) raw = splitPyCells(await readTextFile(path));
  else {
    try { raw = await readNotebook(path); } catch (e) {
      // Jupyter and VS Code write the notebook in place: reading it in the
      // middle of a save gives half a JSON. One retry a moment later, and
      // only then is the file really not a notebook.
      if (!/no es un cuaderno de Jupyter v/i.test(String((e && e.message) || e))) throw e;
      await new Promise((r) => setTimeout(r, 200));
      raw = await readNotebook(path);
      st = (await fileStamps([path]))[0] || st;
    }
  }
  const dir = dirOf(path);
  const cells = [];
  (raw || []).forEach((c, i) => {
    const code = String((c && c.source) || '');
    if (!code.trim()) return;
    cells.push({
      code,
      codeHash: hashString(code),
      // Jupyter's own cell id when the notebook has them (nbformat ≥ 4.5),
      // so a cell keeps its identity when others are inserted around it.
      id: `nb-${(c && c.id) || i + 1}`,
      index: i,
      nth: i + 1, // the code cell's number, for messages
      headerLn: 0,
      notebook: path,
      dir,
    });
  });
  cache.set(path, { mtime: st.mtime, size: st.size, cells });
  return cells;
}
