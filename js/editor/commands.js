// Editor-facing actions used by the ribbon. Centralizes access to the current
// CodeMirror view so tab components stay declarative.

import { undo, redo, moveLineUp, moveLineDown } from '@codemirror/commands';
import { openSearchPanel } from '@codemirror/search';
import { EditorView } from '@codemirror/view';
import { state } from '../core/state.js';
import { getView } from './setup.js';
import { insertCellTemplate, runAllCells, clearCellOutputs, runCellAtCursor, setOutputsHidden, collapseAllCells, parseCells } from './cells.js';
import {
  tableAddRow, tableAddColumn, tableDeleteRow, tableDeleteColumn, tableToggleHline,
  tableSetColumnAlign, insertTable,
} from './latex-table.js';

const withView = (fn) => () => {
  const v = getView();
  if (v) {
    fn(v);
    v.focus();
  }
};

export const doUndo = withView((v) => undo(v));
export const doRedo = withView((v) => redo(v));
export const openFind = () => {
  const v = getView();
  if (v) openSearchPanel(v);
};
export const clip = (action) => {
  const v = getView();
  if (v) {
    v.focus();
    try { document.execCommand(action); } catch (_) { /* ignore */ }
  }
};

export const insertCell = withView((v) => insertCellTemplate(v));

// Paste via the async clipboard API (execCommand('paste') is blocked in
// Chromium); falls back to execCommand for older environments.
export async function pasteClipboard() {
  const v = getView();
  if (!v) return;
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      const sel = v.state.selection.main;
      v.dispatch({
        changes: { from: sel.from, to: sel.to, insert: text },
        selection: { anchor: sel.from + text.length },
      });
    }
  } catch (_) {
    try { document.execCommand('paste'); } catch (_2) { /* ignore */ }
  }
  v.focus();
}

export const selectAll = withView((v) =>
  v.dispatch({ selection: { anchor: 0, head: v.state.doc.length } }));
export const runCurrentCell = withView((v) => runCellAtCursor(v));
export const runAll = () => {
  const v = getView();
  if (v) runAllCells(v);
};
export const clearOutputs = withView((v) => clearCellOutputs(v));
export const toggleHideOutputs = () => {
  const v = getView();
  if (!v) return;
  state.hideOutputs = !state.hideOutputs;
  setOutputsHidden(v, state.hideOutputs);
  v.focus();
};

// Fold/unfold every cell (code + output) at once — distinct from "hide
// outputs": cells stay, just collapsed to a thin cap, reopenable one by one.
export const toggleCollapseAll = () => {
  const v = getView();
  if (!v) return;
  state.cellsCollapsed = !state.cellsCollapsed;
  collapseAllCells(v, state.cellsCollapsed);
  v.focus();
};

// Move the cursor to a 1-based line and scroll it into view (TOC jump). Just
// places the caret — no token selection (that's only for SyncTeX clicks).
export function gotoLine(lineNo) {
  const v = getView();
  if (!v) return;
  const n = Math.max(1, Math.min(lineNo, v.state.doc.lines));
  const line = v.state.doc.line(n);
  v.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
  v.focus();
}

// The token (a \command, a \py{…} or a plain word) covering column `col` in a
// line, so SyncTeX lands on the EXACT word/cell — highlighted, not just the line.
function tokenAt(text, col) {
  const cmd = /\\[a-zA-Z@]+\*?(?:\{[^{}]*\})?/g;
  let m;
  while ((m = cmd.exec(text))) {
    if (col >= m.index && col <= m.index + m[0].length) return [m.index, m.index + m[0].length];
  }
  const word = /[\p{L}\p{M}\p{N}]+/gu;
  while ((m = word.exec(text))) {
    if (col >= m.index && col <= m.index + m[0].length) return [m.index, m.index + m[0].length];
  }
  return null;
}
// Find `word` in a line, picking the occurrence nearest to `nearCol`. Used so a
// PDF Ctrl+click lands on the EXACT word that was clicked — SyncTeX's column is
// unreliable, but the clicked word's text is not.
function findWordInLine(text, word, nearCol) {
  const occ = [];
  let i = text.indexOf(word);
  while (i >= 0) { occ.push(i); i = text.indexOf(word, i + 1); }
  if (!occ.length) {
    const lt = text.toLowerCase(), lw = word.toLowerCase();
    let j = lt.indexOf(lw);
    while (j >= 0) { occ.push(j); j = lt.indexOf(lw, j + 1); }
  }
  if (!occ.length) return null;
  let best = occ[0], bd = Math.abs(occ[0] - nearCol);
  for (const o of occ) { const d = Math.abs(o - nearCol); if (d < bd) { bd = d; best = o; } }
  return [best, best + word.length];
}

export function gotoLineCol(lineNo, col, word) {
  const v = getView();
  if (!v) return;
  const n = Math.max(1, Math.min(lineNo, v.state.doc.lines));
  const line = v.state.doc.line(n);

  // Most reliable: if the exact word clicked in the PDF is known, find THAT word
  // in the source line (nearest the SyncTeX column) and select it precisely.
  if (word && word.length >= 1) {
    const near = typeof col === 'number' && col > 0 ? col : 0;
    let hit = findWordInLine(line.text, word, near);
    // A multi-word PDF selection may not match verbatim (LaTeX markup); fall
    // back to its first word so the jump still lands on the right token.
    if (!hit) {
      const fw = (word.match(/[\p{L}\p{N}]+/u) || [])[0];
      if (fw && fw !== word) hit = findWordInLine(line.text, fw, near);
    }
    if (hit) {
      v.dispatch({
        selection: { anchor: line.from + hit[0], head: line.from + hit[1] },
        effects: EditorView.scrollIntoView(line.from + hit[0], { y: 'center' }),
      });
      v.focus();
      return;
    }
  }

  let colOff;
  if (typeof col === 'number' && col > 0) {
    colOff = Math.min(col, line.length);
  } else {
    const py = line.text.indexOf('\\py{');
    colOff = py >= 0 ? py : Math.max(0, line.text.search(/\S/));
  }
  // Select the exact token under that column (word, command or \py{…}); fall
  // back to just placing the caret when between tokens.
  const tok = tokenAt(line.text, colOff);
  const sel = tok
    ? { anchor: line.from + tok[0], head: line.from + tok[1] }
    : { anchor: line.from + colOff };
  v.dispatch({
    selection: sel,
    effects: EditorView.scrollIntoView(line.from + colOff, { y: 'center' }),
  });
  v.focus();
}

// Ctrl+T: comment / uncomment the selected lines. Uses `#` inside Python cells
// and `%` for LaTeX (decided per line). Toggles: if every non-blank line in the
// range is already commented, it uncomments; otherwise it comments.
export function toggleLineComment(view) {
  const v = view || getView();
  if (!v) return true;
  const { state } = v;
  const sel = state.selection.main;
  const fromLine = state.doc.lineAt(sel.from).number;
  const toLine = state.doc.lineAt(sel.to).number;
  const cells = parseCells(state);
  const ccFor = (ln) => (cells.some((c) => ln > c.headerLine && ln < c.endLine) ? '#' : '%');

  const rows = [];
  let anyContent = false, allCommented = true;
  for (let ln = fromLine; ln <= toLine; ln++) {
    const line = state.doc.line(ln);
    const cc = ccFor(ln);
    rows.push({ line, cc });
    if (line.text.trim()) {
      anyContent = true;
      if (!line.text.replace(/^\s*/, '').startsWith(cc)) allCommented = false;
    }
  }
  const uncomment = anyContent && allCommented;
  const changes = [];
  for (const { line, cc } of rows) {
    if (uncomment) {
      const m = line.text.match(new RegExp('^(\\s*)' + cc + ' ?'));
      if (m) changes.push({ from: line.from, to: line.from + m[0].length, insert: m[1] });
    } else {
      const indent = (line.text.match(/^\s*/) || [''])[0];
      changes.push({ from: line.from + indent.length, insert: cc + ' ' });
    }
  }
  if (changes.length) v.dispatch({ changes });
  v.focus();
  return true;
}

// Smart Enter (TeXstudio-style): after `\begin{env}` open the body and add the
// matching `\end{env}`; on an `\item` line continue with a new `\item`. Returns
// false (so the editor's normal Enter runs) outside those cases and in cells.
export function smartEnter(view) {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const line = state.doc.lineAt(sel.head);
  if (sel.head !== line.to) return false; // only at the end of the line
  const ln = line.number;
  if (parseCells(state).some((c) => ln >= c.headerLine && ln <= c.endLine)) return false;
  const indent = (line.text.match(/^[ \t]*/) || [''])[0];

  // `\begin{document}` is the document wrapper, not a block to auto-close — a
  // stray `\end{document}` mid-file breaks the compile, so skip the auto-end
  // for it (the user adds the single matching \end themselves).
  const mb = line.text.match(/\\begin\{([^}]+)\}\s*$/);
  if (mb && mb[1] !== 'document') {
    const body = `\n${indent}  `;
    const close = `\n${indent}\\end{${mb[1]}}`;
    view.dispatch({
      changes: { from: sel.head, insert: body + close },
      selection: { anchor: sel.head + body.length },
      scrollIntoView: true,
    });
    return true;
  }
  const mItem = line.text.match(/^(\s*)\\item\b/);
  if (mItem) {
    const insert = `\n${mItem[1]}\\item `;
    view.dispatch({
      changes: { from: sel.head, insert },
      selection: { anchor: sel.head + insert.length },
      scrollIntoView: true,
    });
    return true;
  }
  return false;
}

export function insertSnippet(text) {
  const v = getView();
  if (!v) return;
  const sel = v.state.selection.main;
  v.dispatch({
    changes: { from: sel.from, to: sel.to, insert: text },
    selection: { anchor: sel.from + text.length },
  });
  v.focus();
}

/* ---- change case (Word-style "Aa") ---- */
const WORD_AT = /[\p{L}\p{M}\p{N}]+/u;
function selectionRange(v) {
  const sel = v.state.selection.main;
  if (!sel.empty) return { from: sel.from, to: sel.to };
  // No selection → the word under the caret.
  const line = v.state.doc.lineAt(sel.head);
  const col = sel.head - line.from;
  const re = /[\p{L}\p{M}\p{N}]+/gu;
  let m;
  while ((m = re.exec(line.text))) {
    if (col >= m.index && col <= m.index + m[0].length) {
      return { from: line.from + m.index, to: line.from + m.index + m[0].length };
    }
  }
  return null;
}
export function changeCase(mode) {
  const v = getView();
  if (!v) return;
  const r = selectionRange(v);
  if (!r) return;
  const text = v.state.sliceDoc(r.from, r.to);
  let out = text;
  if (mode === 'lower') out = text.toLocaleLowerCase();
  else if (mode === 'upper') out = text.toLocaleUpperCase();
  // Sentence: lowercase, then capitalize the FIRST letter (skipping any leading
  // spaces/quotes/punctuation) — "solo la inicial".
  else if (mode === 'sentence') out = text.toLocaleLowerCase().replace(/\p{L}/u, (c) => c.toLocaleUpperCase());
  // Title: capitalize the first letter of EVERY word (the `g` flag was missing,
  // so only the first word was being capitalized).
  else if (mode === 'title') out = text.toLocaleLowerCase().replace(/[\p{L}\p{M}\p{N}]+/gu, (w) => w.charAt(0).toLocaleUpperCase() + w.slice(1));
  else if (mode === 'toggle') out = [...text].map((c) => c === c.toLocaleLowerCase() ? c.toLocaleUpperCase() : c.toLocaleLowerCase()).join('');
  v.dispatch({ changes: { from: r.from, to: r.to, insert: out }, selection: { anchor: r.from, head: r.from + out.length } });
  v.focus();
}

/* ---- table editing (TeXstudio-style) ---- */
// Add row/column fall back to inserting a fresh table when the caret isn't in
// one; delete/hline are no-ops outside a table.
export const tblAddRow = () => { const v = getView(); if (v && !tableAddRow(v)) insertTable(v); };
export const tblAddCol = () => { const v = getView(); if (v && !tableAddColumn(v)) insertTable(v); };
export const tblDelRow = () => { const v = getView(); if (v) tableDeleteRow(v); };
export const tblDelCol = () => { const v = getView(); if (v) tableDeleteColumn(v); };
export const tblHline = () => { const v = getView(); if (v) tableToggleHline(v); };
export const tblInsert = () => { const v = getView(); if (v) insertTable(v); };
// Align the current column's text left/center/right (l/c/r) — TeXstudio's
// "align column" tool; adjusts only the column spec.
export const tblAlign = (align) => { const v = getView(); if (v) tableSetColumnAlign(v, align); };

/* ---- SyncTeX forward search: cursor line → PDF position (TeXstudio) ---- */
// The build copy preserves the source's line numbers exactly, so the cursor
// line maps 1:1. Tries the doc's .build.tex name first (what the engine read
// for processed files), then the raw path (unprocessed .tex children).
export async function forwardSearch() {
  const v = getView();
  const d = state.documents[state.activeIndex];
  if (!v || !d || d.kind || !d.path || !state.lastPdfPath) return;
  const line = v.state.doc.lineAt(v.state.selection.main.head).number;
  const { synctexView } = await import('../core/platform.js');
  const stem = d.path.replace(/\.(tex|pltx)$/i, '');
  for (const tex of [stem + '.build.tex', d.path]) {
    try {
      const loc = await synctexView(tex, line, state.lastPdfPath);
      if (loc && loc.page) {
        state.previewVisible = true;
        const prev = await import('../pdf/preview.js');
        await prev.showPdfLocation(loc.page, loc.x, loc.y);
        return;
      }
    } catch (_) { /* try the next candidate */ }
  }
}

/* ---- move cell / line (Alt+↑ / Alt+↓, Jupyter/VSCode-style) ---- */
// Inside a cell the WHOLE cell block moves one line per press (hold to glide);
// outside, the regular line move runs. Returns true at document edges so the
// default line-move can never split a cell apart.
function moveCell(view, dir) {
  const st = view.state;
  const sel = st.selection.main;
  const ln = st.doc.lineAt(sel.head).number;
  const cell = parseCells(st).find((c) => ln >= c.headerLine && ln <= c.endLine);
  if (!cell) return false;
  const first = st.doc.line(cell.headerLine);
  const last = st.doc.line(cell.endLine);
  const block = st.sliceDoc(first.from, last.to);
  if (dir < 0) {
    if (cell.headerLine <= 1) return true;
    const prev = st.doc.line(cell.headerLine - 1);
    view.dispatch({
      changes: { from: prev.from, to: last.to, insert: block + '\n' + prev.text },
      selection: { anchor: sel.head - (prev.length + 1) },
      scrollIntoView: true,
    });
  } else {
    if (cell.endLine >= st.doc.lines) return true;
    const next = st.doc.line(cell.endLine + 1);
    view.dispatch({
      changes: { from: first.from, to: next.to, insert: next.text + '\n' + block },
      selection: { anchor: sel.head + (next.length + 1) },
      scrollIntoView: true,
    });
  }
  return true;
}
export const moveCellOrLineUp = (view) => moveCell(view, -1) || moveLineUp(view);
export const moveCellOrLineDown = (view) => moveCell(view, 1) || moveLineDown(view);

/* ---- wrap selection in an environment (TeXstudio's "surround with…") ---- */
export function wrapInEnvironment(env) {
  const v = getView();
  if (!v || !env) return;
  const st = v.state;
  const sel = st.selection.main;
  if (sel.empty) {
    // No selection → insert an empty environment with the caret inside.
    const line = st.doc.lineAt(sel.head);
    const indent = (line.text.match(/^[ \t]*/) || [''])[0];
    const head = `\\begin{${env}}\n${indent}  `;
    v.dispatch({
      changes: { from: sel.head, insert: `${head}\n${indent}\\end{${env}}` },
      selection: { anchor: sel.head + head.length },
      scrollIntoView: true,
    });
  } else {
    // Whole-line wrap: the selected lines become the environment body.
    const fromLine = st.doc.lineAt(sel.from);
    const toLine = st.doc.lineAt(sel.to);
    const indent = (fromLine.text.match(/^[ \t]*/) || [''])[0];
    const inner = st.sliceDoc(fromLine.from, toLine.to);
    const body = inner.split('\n').map((l) => (l.trim() ? '  ' + l : l)).join('\n');
    const text = `${indent}\\begin{${env}}\n${body}\n${indent}\\end{${env}}`;
    v.dispatch({
      changes: { from: fromLine.from, to: toLine.to, insert: text },
      selection: { anchor: fromLine.from, head: fromLine.from + text.length },
      scrollIntoView: true,
    });
  }
  v.focus();
}

export function wrap(before, after = '') {
  const v = getView();
  if (!v) return;
  const sel = v.state.selection.main;
  const selected = v.state.sliceDoc(sel.from, sel.to);
  v.dispatch({
    changes: { from: sel.from, to: sel.to, insert: before + selected + after },
    selection: { anchor: sel.from + before.length, head: sel.from + before.length + selected.length },
  });
  v.focus();
}
