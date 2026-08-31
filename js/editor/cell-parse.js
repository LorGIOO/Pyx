// Locating the Python cells in a document. Pure: no DOM, no CodeMirror view,
// no kernel — which is what lets the compiler, the document store and the test
// suite use it without dragging the editor in.
//
// A cell is the region between `%#python` and `%#end`. Both are LaTeX comments,
// so the file stays valid LaTeX and diffs cleanly in git.
//
// The opening marker carries a STABLE identifier: `%#python id=a1b2c3d4`. That
// id is what a result is filed under, and it is what makes the notebook model
// hold together — see the identity notes in cells.js.

import { createVerbatimTracker } from '../compile/latex-bridge.js';
import { hashString } from '../core/hash.js';

export const CELL_OPEN = '%#python';
export const CELL_CLOSE = '%#end';

const ID_RE = /\bid\s*=\s*([A-Za-z0-9_-]{1,32})/;

/** The stable id declared by a `%#python …` marker line, or null. */
export function markerId(text) {
  const m = ID_RE.exec(text);
  return m ? m[1] : null;
}

/** A cell's output-store key: its stable id, or its ordinal for a legacy cell
 *  that hasn't been given one yet. */
export const cellKey = (cell) => cell.id || ('#' + cell.index);

/** cellKey -> code fingerprint, for the output store's staleness checks. */
export function codeHashMap(cells) {
  const m = new Map();
  for (const c of cells) m.set(cellKey(c), c.codeHash);
  return m;
}

function makeCell(index, id, headerLine, endLine, codeLines) {
  const code = codeLines.join('\n');
  return { index, id, headerLine, endLine, code, codeHash: hashString(code) };
}

// Memoized per document version (CodeMirror Text is immutable): decorations,
// highlighting and cursor tracking all call this on every keystroke, so the
// full-document scan must only happen once per edit, even in huge files.
//
// The scan walks the rope with `iterLines()` — a single linear traversal. The
// old loop called `doc.line(ln)` for every line, and each of those is an
// O(log n) descent through the rope, so a 300 000-line document paid an
// O(n log n) walk on every keystroke.
const cellsCache = new WeakMap();

/** Cells of a CodeMirror EditorState. */
export function parseCells(state) {
  const doc = state.doc;
  const hit = cellsCache.get(doc);
  if (hit) return hit;
  const cells = [];
  // Markers inside verbatim environments (minted, verbatim, lstlisting…) are
  // DISPLAYED code, not cells — the tracker skips them. It only advances while
  // outside a cell (cell bodies are Python, not LaTeX).
  const inVerb = createVerbatimTracker();
  let inCell = false, headerLine = 0, headerText = '', codeLines = [];
  let ln = 0;
  for (const raw of doc.iterLines()) {
    ln++;
    // Fast reject: a marker line always contains '%#'. Most lines in a real
    // document don't.
    const mayMark = raw.indexOf('%#') >= 0;
    const verb = inCell ? false : inVerb(raw);
    if (!inCell && mayMark && !verb && raw.trim().startsWith(CELL_OPEN)) {
      inCell = true; headerLine = ln; headerText = raw; codeLines = [];
    } else if (inCell && mayMark && raw.trim().startsWith(CELL_CLOSE)) {
      cells.push(makeCell(cells.length, markerId(headerText), headerLine, ln, codeLines));
      inCell = false;
    } else if (inCell) codeLines.push(raw);
  }
  cellsCache.set(doc, cells);
  return cells;
}

/** The same scan over a plain string (compiler / document-store side). */
export function parseCellsText(text) {
  const cells = [];
  const inVerb = createVerbatimTracker();
  let inCell = false, codeLines = [], headerText = '', headerLine = 0, ln = 0;
  for (const raw of text.split(/\r?\n/)) {
    ln++;
    const verb = inCell ? false : inVerb(raw);
    const t = raw.trim();
    if (!inCell && !verb && t.startsWith(CELL_OPEN)) {
      inCell = true; codeLines = []; headerText = raw; headerLine = ln;
    } else if (inCell && t.startsWith(CELL_CLOSE)) {
      cells.push(makeCell(cells.length, markerId(headerText), headerLine, ln, codeLines));
      inCell = false;
    } else if (inCell) codeLines.push(raw);
  }
  return cells;
}

/** The cell containing 1-based line `ln`, or null.
 *
 *  Binary search: callers hit this once per visible line and once per \py{}
 *  occurrence, and a linear `.find()` over hundreds of cells made those loops
 *  quadratic. Cells are disjoint and already sorted by position, so a bisect is
 *  exact. */
export function cellAtLine(cells, ln) {
  let lo = 0, hi = cells.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = cells[mid];
    if (ln < c.headerLine) hi = mid - 1;
    else if (ln > c.endLine) lo = mid + 1;
    else return c;
  }
  return null;
}
