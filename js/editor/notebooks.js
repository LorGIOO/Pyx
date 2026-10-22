// Jupyter notebooks linked to a document: `\pynotebook{ruta/al/cuaderno.ipynb}`.
//
// The notebook's code cells run in Pyx's kernel AT THAT POINT of the
// document, as if they were the document's own cells — so `\py{L}`,
// `\pyif{…}` and the document's %#python cells see its variables with the
// same syntax as always. The notebook stays the user's to edit in Jupyter or
// VS Code at the same time: it is read from disk whenever it changes, and
// the dependency graph re-runs only the notebook cells that changed and what
// depends on them.
//
// As in Jupyter, a notebook's cells run with ITS folder as the working
// directory (`pd.read_csv("datos.csv")` next to the notebook keeps working).
// Pyx runs the notebook's code; it does not attach to a running Jupyter
// kernel, so the numbers in the document always come from the code on disk.

import { readNotebook, fileStamps } from '../core/platform.js';
import { joinPath, dirOf } from '../core/paths.js';
import { hashString } from '../core/hash.js';
import { createVerbatimTracker, stripTexComment } from '../compile/latex-bridge.js';

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
