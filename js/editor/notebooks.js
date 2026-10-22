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

import { readNotebook, fileStamps } from '../core/platform.js';
import { joinPath, dirOf } from '../core/paths.js';
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
 *  read; null when a cell cannot be followed. */
export function documentReads(codes, exprs) {
  const out = new Set();
  for (const code of codes) {
    const info = analyzePython(code);
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

const CMD = /\\pynotebook\s*\{([^}]+)\}/g;

/** The \pynotebook{…} calls of a LaTeX text, outside comments, verbatim and
 *  Python cells: [{ raw, line }] (1-based line). */
export function notebookRefs(text) {
  const out = [];
  if (!text || text.indexOf('\\pynotebook') < 0) return out;
  const inVerb = createVerbatimTracker();
  let inCell = false;
  let ln = 0;
  for (const line of text.split(/\r?\n/)) {
    ln++;
    const t = line.trim();
    if (inCell) { if (t.startsWith('%#end')) inCell = false; continue; }
    if (inVerb(line)) continue;
    if (t.startsWith('%#python')) { inCell = true; continue; }
    if (line.indexOf('\\pynotebook') < 0) continue;
    const code = stripTexComment(line);
    CMD.lastIndex = 0;
    let m;
    while ((m = CMD.exec(code))) out.push({ raw: m[1].trim(), line: ln });
  }
  return out;
}

/** The notebook a \pynotebook argument names: relative to the ROOT
 *  document's folder (like \input), `.ipynb` added when left out. null for a
 *  relative path with no folder to resolve it from (an unsaved document). */
export function notebookPath(rootDir, raw) {
  let r = String(raw || '').trim();
  if (!/\.ipynb$/i.test(r)) r += '.ipynb';
  if (/^([a-zA-Z]:[\\/]|[\\/])/.test(r)) return r;
  return rootDir ? joinPath(rootDir, r) : null;
}

const cache = new Map(); // path -> { mtime, size, cells }

/**
 * The notebook's code cells as Pyx cells, read again only when the file
 * changed on disk. Each cell: { code, codeHash, id, index, nth, headerLn: 0,
 * notebook: path, dir: the notebook's folder }. Throws with the reason when
 * the notebook cannot be read.
 */
export async function loadNotebook(path) {
  const [st] = await fileStamps([path]);
  if (!st || st.mtime < 0) throw new Error(`no se encuentra el cuaderno ${path}`);
  const hit = cache.get(path);
  if (hit && hit.mtime === st.mtime && hit.size === st.size) return hit.cells;
  const raw = await readNotebook(path);
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
