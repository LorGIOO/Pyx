// VSCode/Jupyter-style Python cells embedded in a .tex document.
//
// A cell is the region between `%#python` and `%#end`. Both markers are LaTeX
// comments, so the file stays valid LaTeX — but Pyx HIDES the markers entirely
// (they are replaced by the cell's toolbar and output blocks) so the editor
// looks exactly like a VSCode notebook cell. Typing the markers creates a cell;
// the cell is removed with its trash button (or by deleting the lines).
//
// CELL IDENTITY — read before changing anything here.
//
// The opening marker carries a stable identifier: `%#python id=a1b2c3d4`. It
// is what a result is filed under, and it is what makes the notebook model
// hold together:
//
//   * Editing a cell while it runs no longer loses the result (the key does
//     not depend on the code).
//   * Two cells with identical code are two cells, not one.
//   * Results can be stored in the .pltx and restored on open, matched back to
//     the exact cell that produced them.
//   * A result whose cell has changed since it ran is marked STALE instead of
//     silently passing for current — in an engineering document, a number that
//     no longer matches its formula is the most expensive kind of bug.
//
// Ids are written automatically the first time a cell runs, so existing
// documents migrate by being used. Until then a cell falls back to its ordinal.

import { StateField, StateEffect } from '@codemirror/state';
import { EditorView, Decoration, WidgetType, ViewPlugin } from '@codemirror/view';
import { classifyPythonCached } from './py-highlight.js';
import { state as appState } from '../core/state.js';
import { dirOf } from '../core/paths.js';
import { randomId } from '../core/hash.js';
import { docIdOf } from './doc-id.js';
import {
  CELL_OPEN, CELL_CLOSE, cellKey, parseCells, cellAtLine,
} from './cell-parse.js';
import { runCellCode, withKernelLock, interruptKernel, nsRecord, nsPrefix, nsInvalidate } from './cell-runner.js';
import { broadcastCellRefresh } from './setup.js';
import { getOutput, setOutput, deleteOutput, clearDoc, gcDoc } from './cell-outputs.js';
import { createRichFrame, sanitizeFragment, needsIsolation } from './rich-frame.js';
import { renderMath } from './math-render.js';
// The shared icon set, for the cell's context menus (`MI` = menu icons).
import { icons as MI } from '../solid/components/ribbon/icons.js';

// Python cells work in any text document (.pltx, .tex or unsaved): you can drop
// cells into a .tex too — on save it is offered as .pltx (handled in docStore).
function pyxActive() {
  const d = appState.documents[appState.activeIndex];
  return !!d && !d.kind;
}

// Cell outputs open as document TABS (VSCode-style), not auxiliary windows.
function openImageTab(src) {
  import('../solid/stores/docStore.js').then((m) => m.openImageTab(src));
}
function openHtmlTab(html) {
  import('../solid/stores/docStore.js').then((m) => m.openHtmlTab(html));
}

// The cell parser is a separate, DOM-free module (cell-parse.js) so the
// compiler, the document store and the tests can use it without pulling the
// editor in. Re-exported here because everything cell-shaped is imported from
// this module.
export {
  CELL_OPEN, CELL_CLOSE, cellKey, codeHashMap,
  parseCells, parseCellsText, cellAtLine,
} from './cell-parse.js';

let execCounter = 0; // notebook-style [1], [2], ...

export const refreshCells = StateEffect.define();
const toggleCollapse = StateEffect.define();    // collapse the cell's CODE
const toggleOutCollapse = StateEffect.define(); // collapse the cell's OUTPUT
// Collapse/expand EVERY cell at once (value: boolean). NOT the same as hiding
// outputs — the cells just fold to a thin cap and can be reopened individually.
const setAllCollapse = StateEffect.define();
const setAllOutCollapse = StateEffect.define();

function makeToggleSet(effect, allEffect) {
  return StateField.define({
    create: () => new Set(),
    update(value, tr) {
      let s = value;
      for (const e of tr.effects) {
        if (e.is(effect)) {
          s = new Set(s);
          if (s.has(e.value)) s.delete(e.value);
          else s.add(e.value);
        } else if (allEffect && e.is(allEffect)) {
          s = e.value ? new Set(parseCells(tr.state).map(cellKey)) : new Set();
        }
      }
      return s;
    },
  });
}
const collapsedCells = makeToggleSet(toggleCollapse, setAllCollapse);
const collapsedOutputs = makeToggleSet(toggleOutCollapse, setAllOutCollapse);

// Fold (or unfold) every cell's CODE and OUTPUT in one shot.
export function collapseAllCells(view, collapsed) {
  if (!pyxActive()) return;
  view.dispatch({ effects: [setAllCollapse.of(collapsed), setAllOutCollapse.of(collapsed)] });
}

// When on, cell outputs collapse to a thin cap so the document takes less
// space — calculations still run and still compile into the PDF.
const setHideOutputs = StateEffect.define();
const hideOutputsState = StateField.define({
  create: () => !!appState.hideOutputs, // keep the toggle consistent across documents
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setHideOutputs)) value = e.value;
    return value;
  },
});
export function setOutputsHidden(view, hidden) {
  view.dispatch({ effects: setHideOutputs.of(hidden) });
}

/* ---------- helpers ---------- */
async function activeCwd() {
  const d = appState.documents[appState.activeIndex];
  const local = dirOf(d?.path);
  if (!d || !d.path) return local;
  // The kernel must run from the PROJECT ROOT's folder, not this file's:
  // otherwise a cell run from an \input'ed chapter saves its figures into a
  // second image folder next to the chapter (the duplicated-folders bug) and
  // relative paths behave differently between manual runs and compiles.
  // Dynamic import — compiler.js statically imports this module.
  try {
    const m = await import('../compile/compiler.js');
    return (await m.activeRootDir()) || local;
  } catch (_) {
    return local;
  }
}

/**
 * Give every cell in the document a stable id, in ONE transaction.
 *
 * Called before any execution. Assigning ids one at a time inside the run loop
 * would invalidate the cell positions mid-iteration; doing it up front keeps
 * the run over a single, consistent snapshot.
 */
export function ensureCellIds(view) {
  const cells = parseCells(view.state);
  const changes = [];
  for (const c of cells) {
    if (c.id) continue;
    const header = view.state.doc.line(c.headerLine);
    const at = header.from + header.text.indexOf(CELL_OPEN) + CELL_OPEN.length;
    changes.push({ from: at, insert: ` id=${randomId()}` });
  }
  if (changes.length) view.dispatch({ changes, annotations: [] });
  return parseCells(view.state);
}

/* ---------- run / edit actions ---------- */
// Internal executor — callers must hold the kernel lock. The lock keeps a cell
// run from slipping INTO another sequence (e.g. between the compile's kernel
// reset and its import cells), which produced phantom NameErrors (plt, np…).
async function execCell(docId, cell, cwd) {
  const key = cellKey(cell);
  const prev = getOutput(docId, key) || {};
  setOutput(docId, key, { ...prev, running: true, codeHash: cell.codeHash });
  broadcastCellRefresh();
  const t0 = performance.now();
  const res = await runCellCode(cell.code, { cwd });
  const ms = performance.now() - t0;
  const count = res.ok ? ++execCounter : prev.count || null;
  setOutput(docId, key, { ...res, running: false, count, ms, codeHash: cell.codeHash });
  if (res.ok) nsRecord(cell.codeHash, cwd);
  else nsInvalidate();
  broadcastCellRefresh();
  return res;
}

/* A MANUALLY run handcalcs cell (%%render/%%tex) IS document content: the PDF
   must show it right away, so a background compile fires automatically after
   the run. Debounced (run-all fires once at the end) and it retries while a
   compile is in flight. */
let hcTimer = null;
function scheduleHandcalcsCompile() {
  clearTimeout(hcTimer);
  const fire = () => {
    if (appState.compiling) { hcTimer = setTimeout(fire, 300); return; }
    const d = appState.documents[appState.activeIndex];
    if (!d || d.kind || !d.path) return; // unsaved docs can't compile yet
    import('../compile/compiler.js').then((m) => m.compileActive(false)).catch(() => {});
  };
  hcTimer = setTimeout(fire, 120);
}

async function runOne(view, cell) {
  const docId = docIdOf(view.state);
  const cwd = await activeCwd();
  const res = await withKernelLock(() => execCell(docId, cell, cwd));
  if (res && res.ok && res.render) scheduleHandcalcsCompile();
}

function findByKey(view, key) {
  return parseCells(view.state).find((c) => cellKey(c) === key) || null;
}
function runCellByKey(view, key) {
  const cells = ensureCellIds(view);
  // The id assignment may have turned an ordinal key into a real id: re-locate
  // by position rather than by the (possibly stale) key.
  const cell = cells.find((c) => cellKey(c) === key)
    || (key.startsWith('#') ? cells[+key.slice(1)] : null);
  if (cell) runOne(view, cell);
}
function deleteCellByKey(view, key) {
  const cell = findByKey(view, key);
  if (!cell) return;
  const docId = docIdOf(view.state);
  const from = view.state.doc.line(cell.headerLine).from;
  const endLine = view.state.doc.line(cell.endLine);
  const to = cell.endLine < view.state.doc.lines ? view.state.doc.line(cell.endLine + 1).from : endLine.to;
  view.dispatch({ changes: { from, to, insert: '' } });
  deleteOutput(docId, key);
  view.focus();
}

/* ---------- the actions VSCode puts on a notebook cell ----------
   Same set, same meaning, so muscle memory transfers: run everything above,
   run this one and everything below, split at the caret, and a "…" menu for
   the rest. They all go through the kernel lock, because a half-run sequence
   leaves the namespace describing a document that never existed. */

/** Run cells[from…to) in order, stopping at the first failure. */
async function runRange(view, from, to) {
  const docId = docIdOf(view.state);
  const cwd = await activeCwd();
  let render = false;
  await withKernelLock(async () => {
    const cells = parseCells(view.state);
    for (let i = from; i < Math.min(to, cells.length); i++) {
      const res = await execCell(docId, cells[i], cwd);
      if (res && res.ok === false) break; // a failed cell poisons what follows
      if (res && res.render) render = true;
    }
  });
  if (render) scheduleHandcalcsCompile();
}

function indexOfKey(view, key) {
  return ensureCellIds(view).findIndex((c) => cellKey(c) === key);
}

/** Everything ABOVE this cell — what you run to rebuild the state it needs. */
function runCellsAbove(view, key) {
  const i = indexOfKey(view, key);
  if (i > 0) runRange(view, 0, i);
}

/** This cell and everything BELOW it. */
function runCellsBelow(view, key) {
  const i = indexOfKey(view, key);
  if (i >= 0) runRange(view, i, Infinity);
}

/**
 * Split the cell at the caret: the lines above stay, the rest becomes a new
 * cell right below. The result of the original cell stays with the original
 * (its id does not move), which is what VSCode does too.
 */
function splitCellByKey(view, key) {
  const cell = findByKey(view, key);
  if (!cell) return;
  const head = view.state.selection.main.head;
  const ln = view.state.doc.lineAt(head).number;
  // Only meaningful strictly inside the code, with a line on each side.
  if (ln <= cell.headerLine + 1 || ln > cell.endLine - 1) return;
  const at = view.state.doc.line(ln).from;
  const insert = `${CELL_CLOSE}\n${CELL_OPEN} id=${randomId()}\n`;
  view.dispatch({ changes: { from: at, insert }, selection: { anchor: at + insert.length } });
  view.focus();
}

/** Insert an empty cell immediately above or below this one. */
function insertCellNear(view, key, where) {
  const cell = findByKey(view, key);
  if (!cell) return;
  const doc = view.state.doc;
  const at = where === 'above'
    ? doc.line(cell.headerLine).from
    : (cell.endLine < doc.lines ? doc.line(cell.endLine + 1).from : doc.line(cell.endLine).to);
  const open = `${CELL_OPEN} id=${randomId()}`;
  const snippet = `${open}\n\n${CELL_CLOSE}\n`;
  const pre = where === 'above' || at === doc.length ? '' : '';
  view.dispatch({
    changes: { from: at, insert: pre + snippet },
    selection: { anchor: at + pre.length + open.length + 1 },
  });
  view.focus();
}

/** The cell's code, as text — for "copiar celda". */
function cellText(view, key) {
  const cell = findByKey(view, key);
  return cell ? cell.code : '';
}

/** Did this cell actually produce anything? */
function hasOutput(out) {
  if (!out) return false;
  return !!(out.stdout || out.stderr || out.error || out.count
    || (out.result != null && out.result !== '')
    || (out.displays && out.displays.length) || (out.images && out.images.length));
}

/** Everything the output shows, as plain text — for "copiar la salida". */
function outputText(out) {
  if (!out) return '';
  const parts = [];
  if (out.stdout) parts.push(out.stdout);
  if (out.stderr) parts.push(out.stderr);
  if (out.error) {
    const e = out.error;
    parts.push(`${e.type || 'Error'}: ${e.msg || ''}`.trim());
  }
  if (out.result != null && out.result !== '') parts.push(String(out.result));
  return parts.join('\n').replace(/\n+$/, '');
}

function copyText(text) {
  if (!text) return;
  try {
    navigator.clipboard.writeText(text);
  } catch (_) {
    // Clipboard API unavailable (older WebView2 / no focus): fall back.
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (__) {}
    ta.remove();
  }
}

export function runCellAtCursor(view) {
  if (!pyxActive()) return false;
  const ln = view.state.doc.lineAt(view.state.selection.main.head).number;
  if (!cellAtLine(parseCells(view.state), ln)) return false;
  const cells = ensureCellIds(view);
  const cell = cellAtLine(cells, view.state.doc.lineAt(view.state.selection.main.head).number);
  if (cell) { runOne(view, cell); return true; }
  return false;
}

// Shift+Enter, Jupyter-style: run the cell AND move the cursor below it. When
// the cell is the last line of the document, a new line is created so you can
// keep writing right away.
export function runCellAndAdvance(view) {
  if (!pyxActive()) return false;
  const ln0 = view.state.doc.lineAt(view.state.selection.main.head).number;
  if (!cellAtLine(parseCells(view.state), ln0)) return false;
  const cells = ensureCellIds(view);
  const cell = cellAtLine(cells, view.state.doc.lineAt(view.state.selection.main.head).number);
  if (!cell) return false;
  runOne(view, cell);
  const doc = view.state.doc;
  if (cell.endLine >= doc.lines) {
    view.dispatch({
      changes: { from: doc.length, insert: '\n' },
      selection: { anchor: doc.length + 1 },
      scrollIntoView: true,
    });
  } else {
    view.dispatch({
      selection: { anchor: doc.line(cell.endLine + 1).from },
      scrollIntoView: true,
    });
  }
  view.focus();
  return true;
}

/**
 * Run ONE cell identified by its stable key — through a view when the file is
 * open (inline outputs update) or directly against the kernel otherwise. Used
 * by the multi-file compiler. Callers must hold the kernel lock.
 */
export async function execCellFor(view, docId, cell, cwd) {
  if (view && docId != null) return execCell(docId, cell, cwd);
  const res = await runCellCode(cell.code, { cwd });
  if (res.ok) nsRecord(cell.codeHash, cwd);
  else nsInvalidate();
  return res;
}

/**
 * Run every cell of the document.
 *
 * INCREMENTAL BY DEFAULT. The kernel remembers the exact ordered list of cell
 * bodies it has executed since its last reset (see cell-runner). When that
 * list is a prefix of what we are about to run — the usual case while writing,
 * where only the last cells changed — the namespace is already correct for
 * that prefix and only the tail needs to run. Nothing is skipped that could
 * change the result: a divergence anywhere forces a full reset and re-run.
 *
 * `force` (the "Run all" button) always resets: it is the ground truth.
 */
async function runAllCellsHeld(view, { force = false, cwd } = {}) {
  if (!pyxActive()) return;
  const docId = docIdOf(view.state);
  const cells = parseCells(view.state);
  if (!cells.length) return;
  const dir = cwd !== undefined ? cwd : await activeCwd();
  const start = force ? 0 : nsPrefix(cells.map((c) => c.codeHash), dir);
  if (start === 0) await runCellCode('', { cwd: dir, reset: true });
  for (let i = start; i < cells.length; i++) {
    const res = await execCell(docId, cells[i], dir);
    if (res && res.ok === false) break; // a failed cell poisons everything below
  }
}

export async function runAllCells(view, { force = true } = {}) {
  if (!pyxActive()) return;
  if (!parseCells(view.state).length) return;
  const cells = ensureCellIds(view);
  const docId = docIdOf(view.state);
  // One lock for the WHOLE sequence: reset + every cell runs atomically, so a
  // concurrent Shift+Enter can never land between the reset and the imports.
  await withKernelLock(() => runAllCellsHeld(view, { force }));
  // If any cell produced a handcalcs render, refresh the PDF now (one compile
  // for the whole run, not one per cell).
  const any = cells.some((c) => {
    const o = getOutput(docId, cellKey(c));
    return o && o.ok && o.render;
  });
  if (any) scheduleHandcalcsCompile();
}

// Ctrl+A: inside a cell selects only the cell's code; otherwise returns false
// so the editor's default "select all" runs.
export function selectCellOrAll(view) {
  const ln = view.state.doc.lineAt(view.state.selection.main.head).number;
  const cell = cellAtLine(parseCells(view.state), ln);
  if (!cell || cell.endLine - 1 < cell.headerLine + 1) return false;
  const from = view.state.doc.line(cell.headerLine + 1).from;
  const to = view.state.doc.line(cell.endLine - 1).to;
  view.dispatch({ selection: { anchor: from, head: to } });
  return true;
}

export function clearCellOutputs(view) {
  if (view) clearDoc(docIdOf(view.state));
  broadcastCellRefresh();
}

// New cells are EMPTY with the caret already inside (Ctrl+Alt+C), so you can
// start typing instantly without clicking into the cell. The stable id is
// written from the start.
export function insertCellTemplate(view) {
  if (!pyxActive()) return; // cells exist only in text documents
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const prefix = line.length ? '\n' : '';
  const open = `${CELL_OPEN} id=${randomId()}`;
  const snippet = `${prefix}${open}\n\n${CELL_CLOSE}\n`;
  view.dispatch({
    changes: { from: line.to, insert: snippet },
    selection: { anchor: line.to + prefix.length + open.length + 1 },
  });
  view.focus();
}

/* ---------- icons ----------
   Drawn to match the codicons VSCode uses on a notebook cell: a 16×16 box,
   1.2px strokes, no fills except the play/stop glyphs. The point is that they
   read as part of the same family as the rest of the editor rather than as
   web iconography. */
const I = {
  compile: '<svg viewBox="0 0 16 16"><path d="M4 2.5v11l9-5.5z"/></svg>',
  trash: '<svg viewBox="0 0 16 16"><path d="M3 4h10M6 4V2.7h4V4M5 4l.7 9h4.6L11 4z" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
  chevronDown: '<svg viewBox="0 0 16 16"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  chevronRight: '<svg viewBox="0 0 16 16"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  expand: '<svg viewBox="0 0 16 16"><path d="M2.5 6V2.5H6M14 6V2.5h-3.5M2.5 10v3.5H6M14 10v3.5h-3.5" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
  stop: '<svg viewBox="0 0 16 16"><rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor"/></svg>',
  clearOut: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.2" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M4.5 11.5l7-7" stroke="currentColor" stroke-width="1.2"/></svg>',
  // codicon "run-above": the bar is what you run, the triangle is where from.
  runAbove: '<svg viewBox="0 0 16 16"><path d="M2.5 3.5h11" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M6 6.5v7l6-3.5z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
  // codicon "run-below"
  runBelow: '<svg viewBox="0 0 16 16"><path d="M2.5 12.5h11" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M6 2.5v7l6-3.5z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
  // codicon "split-vertical": one box becomes two.
  split: '<svg viewBox="0 0 16 16"><rect x="2.5" y="2.5" width="11" height="11" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M2.5 8h11" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
  // codicon "ellipsis"
  more: '<svg viewBox="0 0 16 16"><circle cx="4" cy="8" r="1.1" fill="currentColor"/><circle cx="8" cy="8" r="1.1" fill="currentColor"/><circle cx="12" cy="8" r="1.1" fill="currentColor"/></svg>',
};

function iconBtn(cls, svg, title, onClick) {
  const b = document.createElement('button');
  b.className = 'cell-ico ' + cls;
  b.innerHTML = svg;
  b.title = title;
  b.onmousedown = (e) => e.preventDefault();
  // The event travels through: a "…" button needs it to place its menu.
  b.onclick = (e) => { e.stopPropagation(); onClick(e); };
  return b;
}

/** The app-wide VSCode-style menu, loaded on demand (this module must not
 *  pull the Solid component tree in statically — the compiler imports it). */
function cellMenu(e, items) {
  import('../solid/components/ContextMenu.jsx')
    .then((m) => m.showContextMenu(e, items))
    .catch(() => {});
}

// Small "open in its own tab" button shown on figures and rich output.
function expandBtn(title, onClick) {
  const b = document.createElement('button');
  b.className = 'cell-expand';
  b.innerHTML = I.expand;
  b.title = title;
  b.onmousedown = (e) => e.preventDefault();
  b.onclick = (e) => { e.stopPropagation(); onClick(); };
  return b;
}

/* ---------- cell head (replaces the %#python line, hiding it) ----------
   This is the TOP of the cell box plus the run gutter beside it. The gutter
   lives outside the box (negative offsets), exactly like VSCode's: the play
   button at the top of it, the focus bar down its left edge. */
class CellToolbar extends WidgetType {
  constructor(cell, output, collapsed, active, stale) {
    super();
    this.cell = cell;
    this.key = cellKey(cell);
    this.output = output;
    this.collapsed = collapsed;
    this.active = active;
    this.stale = stale;
  }
  eq(o) {
    return o.key === this.key && o.output === this.output && o.collapsed === this.collapsed
      && o.active === this.active && o.stale === this.stale && o.cell.code === this.cell.code;
  }
  toDOM(view) {
    const out = this.output || {};
    const bar = document.createElement('div');
    bar.className = 'cell-head' + (this.collapsed ? ' collapsed' : '') + (this.active ? ' active' : '');
    bar.contentEditable = 'false';

    // The focus bar and the run button sit in the gutter, left of the box.
    const focus = document.createElement('span');
    focus.className = 'cell-focus';
    bar.appendChild(focus);

    // Play while idle, stop while running — the button swaps in place.
    const run = out.running
      ? iconBtn('run stop', I.stop, 'Interrumpir la ejecución — púlsalo otra vez si la celda no responde', () => interruptKernel())
      : iconBtn('run', I.compile, 'Ejecutar la celda (Mayús+Intro)', () => runCellByKey(view, this.key));
    run.classList.add('cell-gutter-btn');
    bar.appendChild(run);

    // The fold chevron sits in the gutter next to the run button, outside the
    // box — where VSCode puts it.
    const fold = iconBtn('collapse', this.collapsed ? I.chevronRight : I.chevronDown,
      this.collapsed ? 'Expandir' : 'Contraer',
      () => view.dispatch({ effects: toggleCollapse.of(this.key) }));
    fold.classList.add('cell-gutter-fold');
    bar.appendChild(fold);

    const left = document.createElement('div');
    left.className = 'cell-head-left';

    if (this.collapsed) {
      const preview = document.createElement('span');
      preview.className = 'cell-preview';
      const first = (this.cell.code.split('\n').find((l) => l.trim()) || '').trim();
      const n = this.cell.code.split('\n').length;
      preview.textContent = first ? `${first}  ⋯ (${n} líneas)` : `(${n} líneas)`;
      left.appendChild(preview);
    } else if (this.stale) {
      // The code changed after this result was produced. In a calculation
      // report that distinction is the whole point — never let an outdated
      // number pass for a current one.
      const status = document.createElement('span');
      status.className = 'cell-status stale';
      status.textContent = '⟳ resultado desactualizado';
      status.title = 'La celda ha cambiado desde la última ejecución. Vuelve a ejecutarla.';
      left.appendChild(status);
    }
    bar.appendChild(left);

    // The cell toolbar, in VSCode's order and with VSCode's meanings. It stays
    // hidden until the cell is the active one — a cell at rest shows code.
    const right = document.createElement('div');
    right.className = 'cell-actions';
    right.appendChild(iconBtn('above', I.runAbove, 'Ejecutar las celdas anteriores',
      () => runCellsAbove(view, this.key)));
    right.appendChild(iconBtn('below', I.runBelow, 'Ejecutar esta celda y las siguientes',
      () => runCellsBelow(view, this.key)));
    right.appendChild(iconBtn('split', I.split, 'Dividir la celda por el cursor',
      () => splitCellByKey(view, this.key)));
    right.appendChild(iconBtn('more', I.more, 'Más acciones…', (e) => cellMenu(e, [
      { label: 'Cortar celda', icon: MI.cut, shortcut: 'X', onClick: () => { copyText(cellText(view, this.key)); deleteCellByKey(view, this.key); } },
      { label: 'Copiar celda', icon: MI.copy, shortcut: 'C', onClick: () => copyText(cellText(view, this.key)) },
      { separator: true },
      { label: 'Insertar celda arriba', icon: MI.arrowUp, onClick: () => insertCellNear(view, this.key, 'above') },
      { label: 'Insertar celda abajo', icon: MI.arrowDown, onClick: () => insertCellNear(view, this.key, 'below') },
      { separator: true },
      { label: 'Dividir la celda por el cursor', icon: MI.splitCell, onClick: () => splitCellByKey(view, this.key) },
      { label: this.collapsed ? 'Expandir la celda' : 'Contraer la celda', icon: this.collapsed ? MI.expandAll : MI.collapseAll, onClick: () => view.dispatch({ effects: toggleCollapse.of(this.key) }) },
      { separator: true },
      { label: 'Borrar la salida de esta celda', icon: MI.clear, disabled: !hasOutput(out), onClick: () => { deleteOutput(docIdOf(view.state), this.key); broadcastCellRefresh(); } },
      { label: 'Copiar la salida de esta celda', icon: MI.copy, disabled: !hasOutput(out), onClick: () => copyText(outputText(out)) },
      { separator: true },
      { label: 'Eliminar celda', icon: MI.trash, danger: true, onClick: () => deleteCellByKey(view, this.key) },
    ])));
    right.appendChild(iconBtn('danger', I.trash, 'Eliminar celda', () => deleteCellByKey(view, this.key)));
    bar.appendChild(right);

    return bar;
  }
  ignoreEvent() { return true; }
}

/* ---------- output widget (replaces the %#end line, hiding it) ---------- */
function fmtMs(ms) {
  if (ms == null) return '';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
}

// One rich MIME display entry (from the kernel router) → DOM.
//
// Three routes, in order of preference:
//   * image  → <img> from a data: URI (no markup involved at all)
//   * latex  → KaTeX, rendered locally by the app (offline, no scripts)
//   * html   → sanitized inline when it is static; a SANDBOXED frame when it
//              needs to run scripts (plotly, bokeh, widgets)
function renderDisplay(d, body, view) {
  if (d.kind === 'image') {
    const src = 'data:image/png;base64,' + d.data;
    const fig = document.createElement('div');
    fig.className = 'out-fig';
    fig.appendChild(expandBtn('Abrir en otra pestaña', () => openImageTab(src)));
    const img = document.createElement('img');
    img.onload = () => view.requestMeasure();
    img.src = src;
    fig.appendChild(img);
    body.appendChild(fig);
    return;
  }
  // handcalcs / display math: rendered by the bundled KaTeX, no network.
  if (d.kind === 'latex') {
    const holder = document.createElement('div');
    holder.className = 'out-rich-holder';
    holder.appendChild(renderMath(d.data));
    body.appendChild(holder);
    view.requestMeasure();
    return;
  }
  const holder = document.createElement('div');
  holder.className = 'out-rich-holder';
  holder.appendChild(expandBtn('Abrir en otra pestaña', () => openHtmlTab(d.data)));
  if (d.kind === 'html' && needsIsolation(d.data)) {
    holder.appendChild(createRichFrame(d.data, () => view.requestMeasure()));
  } else {
    // Static rich output (SVG, pandas tables, media markup): inline, themed,
    // and stripped of anything executable before it touches the app's DOM.
    const rich = document.createElement('div');
    rich.className = 'out-rich';
    rich.appendChild(sanitizeFragment(d.data));
    holder.appendChild(rich);
  }
  body.appendChild(holder);
}

// Map cell-relative line numbers inside an error message to DOCUMENT lines
// ("unterminated string literal (detected at line 65)" → the real editor line).
function mapMsgLines(msg, headerLine) {
  return String(msg || '').replace(/\b(line|línea)\s+(\d+)/gi,
    (a, w, n) => `${w} ${headerLine + +n}`);
}

function jumpToLine(view, docLine) {
  const n = Math.min(docLine, view.state.doc.lines);
  const line = view.state.doc.line(n);
  view.dispatch({
    selection: { anchor: line.from },
    effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
  });
  view.focus();
}

// Jupyter/VSCode-style COLORED traceback: each part gets its own color —
// location (clickable link to the exact document line), function names, the
// offending source line, the green ^ caret and the bold error type.
function renderTraceback(err, headerLine, body, view) {
  const wrap = document.createElement('div');
  wrap.className = 'out-tb';
  const addLoc = (relLine, name, cur) => {
    const row = document.createElement('div');
    const loc = document.createElement('span');
    loc.className = 'tb-loc';
    loc.textContent = cur ? 'Celda' : 'Otra celda';
    row.appendChild(loc);
    row.appendChild(document.createTextNode(', '));
    const ln = document.createElement('span');
    ln.className = 'tb-line' + (cur ? ' clickable' : '');
    ln.textContent = `línea ${cur ? headerLine + relLine : relLine}`;
    if (cur) {
      ln.title = `Ir a la línea ${headerLine + relLine}`;
      ln.onmousedown = (e) => e.preventDefault();
      ln.onclick = () => jumpToLine(view, headerLine + relLine);
    }
    row.appendChild(ln);
    if (name) {
      row.appendChild(document.createTextNode(', en '));
      const fn = document.createElement('span');
      fn.className = 'tb-func';
      fn.textContent = name + '()';
      row.appendChild(fn);
    }
    wrap.appendChild(row);
  };
  const addCode = (code) => {
    const c = document.createElement('div');
    c.className = 'tb-code';
    c.textContent = '    ' + code;
    wrap.appendChild(c);
  };
  if (Array.isArray(err.frames) && err.frames.length) {
    const h = document.createElement('div');
    h.className = 'tb-head';
    h.textContent = 'Traceback (llamada más reciente al final):';
    wrap.appendChild(h);
    for (const f of err.frames) {
      addLoc(f.line, f.name, f.cur);
      if (f.code) addCode(f.code);
    }
  }
  if (err.syntax) {
    addLoc(err.syntax.line, null, err.syntax.cur !== false);
    if (err.syntax.code) {
      addCode(err.syntax.code);
      if (err.syntax.col > 0) {
        const c = document.createElement('div');
        c.className = 'tb-caret';
        c.textContent = '    ' + ' '.repeat(Math.max(0, err.syntax.col - 1)) + '^';
        wrap.appendChild(c);
      }
    }
  }
  const last = document.createElement('div');
  const ty = document.createElement('span');
  ty.className = 'tb-type';
  ty.textContent = err.type;
  last.appendChild(ty);
  const m = document.createElement('span');
  m.className = 'tb-msg';
  m.textContent = ': ' + mapMsgLines(err.msg, headerLine);
  last.appendChild(m);
  wrap.appendChild(last);
  body.appendChild(wrap);
}

class CellOutput extends WidgetType {
  constructor(key, output, active, hidden, outCollapsed, headerLine, stale) {
    super();
    this.key = key; this.output = output; this.active = active;
    this.hidden = hidden; this.outCollapsed = outCollapsed;
    this.headerLine = headerLine; this.stale = stale;
  }
  eq(o) {
    return o.key === this.key && o.output === this.output && o.active === this.active
      && o.hidden === this.hidden && o.outCollapsed === this.outCollapsed
      && o.headerLine === this.headerLine && o.stale === this.stale;
  }
  // Slim clickable strip shown when THIS output is minimized. Every output
  // type funnels through here — an output that can't collapse is a bug.
  fillCollapsedStrip(view, wrap, out) {
    wrap.classList.add('out-collapsed');
    const row = document.createElement('div');
    row.className = 'cell-out-row';
    const gutter = document.createElement('div');
    gutter.className = 'cell-out-gutter';
    gutter.appendChild(iconBtn('collapse', I.chevronRight, 'Expandir salida',
      () => view.dispatch({ effects: toggleOutCollapse.of(this.key) })));
    row.appendChild(gutter);
    const body = document.createElement('div');
    body.className = 'cell-out-body slim';
    body.textContent = `··· salida oculta${out.ms != null ? ` (${fmtMs(out.ms)})` : ''}`;
    body.onmousedown = (e) => e.preventDefault();
    body.onclick = () => view.dispatch({ effects: toggleOutCollapse.of(this.key) });
    row.appendChild(body);
    wrap.appendChild(row);
  }
  // The gutter under the run button: VSCode shows the execution order at the
  // BOTTOM of the gutter, beside the last line of the cell.
  makeGutter(view, out) {
    const gutter = document.createElement('div');
    gutter.className = 'cell-out-gutter';
    const cnt = document.createElement('div');
    cnt.className = 'out-count';
    cnt.textContent = out.running ? '[*]' : out.count ? `[${out.count}]` : '[ ]';
    cnt.title = out.count ? `Ejecución nº ${out.count}` : 'Sin ejecutar';
    gutter.appendChild(cnt);
    // VSCode puts a "…" beside the output with the actions that belong to the
    // RESULT rather than to the cell.
    const more = iconBtn('outmore', I.more, 'Acciones de la salida…', (e) => cellMenu(e, [
      { label: 'Copiar la salida de esta celda', icon: MI.copy, onClick: () => copyText(outputText(out)) },
      { label: 'Borrar la salida de esta celda', icon: MI.clear, onClick: () => { deleteOutput(docIdOf(view.state), this.key); broadcastCellRefresh(); } },
      { separator: true },
      {
        label: this.outCollapsed ? 'Expandir la salida' : 'Minimizar la salida',
        icon: this.outCollapsed ? MI.expandAll : MI.collapseAll,
        onClick: () => view.dispatch({ effects: toggleOutCollapse.of(this.key) }),
      },
    ]));
    gutter.appendChild(more);
    return gutter;
  }

  /** The 22px status bar that closes the code box: state, time, language. */
  makeStatusBar(view, out) {
    const bar = document.createElement('div');
    bar.className = 'cell-statusbar';

    // The state is an ICON, not a text glyph: ✓ and ✗ pulled in whatever the
    // system font felt like drawing, at a weight and baseline that matched
    // nothing else on screen.
    const state = document.createElement('span');
    state.className = 'cell-st';
    const setState = (cls, icon, label) => {
      state.classList.add(cls);
      state.innerHTML = icon;
      if (label) state.appendChild(document.createTextNode(' ' + label));
    };
    if (out.running) setState('running', MI.refresh, 'Ejecutando…');
    else if (this.stale) setState('stale', MI.refresh, 'desactualizado');
    else if (out.ok === true) setState('ok', MI.pass, '');
    else if (out.ok === false) setState('err', MI.error, 'error');
    bar.appendChild(state);

    if (out.ms != null) {
      const t = document.createElement('span');
      t.className = 'cell-st time';
      t.title = 'Tiempo de ejecución de la celda';
      t.textContent = fmtMs(out.ms);
      bar.appendChild(t);
    }

    const spacer = document.createElement('span');
    spacer.className = 'cell-st-spacer';
    bar.appendChild(spacer);

    const lang = document.createElement('span');
    lang.className = 'cell-st lang';
    lang.textContent = 'Python';
    bar.appendChild(lang);
    return bar;
  }

  toDOM(view) {
    const out = this.output || {};
    const wrap = document.createElement('div');
    wrap.contentEditable = 'false';

    // handcalcs (%%render / %%tex) cells: the calculation IS visible here
    // (KaTeX display) and, when a LaTeX document exists, it ALSO compiles into
    // the PDF in place of the cell.
    if (out.render && !this.hidden) {
      wrap.className = 'cell-out render-note' + (this.active ? ' active' : '')
        + (this.stale ? ' stale' : '');
      if (this.outCollapsed) {
        this.fillCollapsedStrip(view, wrap, out);
        return wrap;
      }
      const b = document.createElement('div'); b.className = 'cell-out-body';
      if (Array.isArray(out.displays)) for (const d of out.displays) renderDisplay(d, b, view);
      wrap.appendChild(this.makeStatusBar(view, out));
      const row = document.createElement('div');
      row.className = 'cell-out-row';
      row.appendChild(this.makeGutter(view, out));
      row.appendChild(b);
      wrap.appendChild(row);
      return wrap;
    }

    const hasContent = out.stdout || out.stderr || out.error ||
      (out.result != null && out.result !== '') ||
      (Array.isArray(out.displays) && out.displays.length) ||
      (Array.isArray(out.images) && out.images.length);
    const has = !this.hidden && hasContent;
    wrap.className = 'cell-out' + (has ? '' : ' empty') + (this.active ? ' active' : '')
      + (this.stale ? ' stale' : '');
    // The status bar closes the code box whether or not the cell printed
    // anything — like VSCode's, it is part of the cell, not of the output.
    wrap.appendChild(this.makeStatusBar(view, out));
    if (!has) return wrap;

    // Output minimized (independent of the code collapse): slim clickable strip.
    if (this.outCollapsed) {
      this.fillCollapsedStrip(view, wrap, out);
      return wrap;
    }

    const row = document.createElement('div');
    row.className = 'cell-out-row';
    row.appendChild(this.makeGutter(view, out));

    const body = document.createElement('div');
    body.className = 'cell-out-body';
    if (out.stdout) body.appendChild(document.createTextNode(out.stdout));
    // VSCode-style error header: type + EXACT document line, click to jump.
    if (out.error && out.error.line != null && this.headerLine) {
      const docLine = this.headerLine + out.error.line;
      const chip = document.createElement('div');
      chip.className = 'out-errline';
      chip.textContent = `✗ ${out.error.type} — línea ${docLine}: ${mapMsgLines(out.error.msg, this.headerLine)}`;
      chip.title = `Ir a la línea ${docLine}`;
      chip.onmousedown = (e) => e.preventDefault();
      chip.onclick = () => jumpToLine(view, docLine);
      body.appendChild(chip);
    }
    // Colored, clickable traceback from the structured error; stderr then only
    // carries what the USER printed to it.
    if (out.error && ((out.error.frames && out.error.frames.length) || out.error.syntax || !out.error.line)) {
      renderTraceback(out.error, this.headerLine || 0, body, view);
    }
    if (out.stderr) { const e = document.createElement('span'); e.className = 'out-err'; e.textContent = out.stderr; body.appendChild(e); }
    if (out.result != null && out.result !== '') {
      const r = document.createElement('span'); r.className = 'out-result'; r.textContent = out.result; body.appendChild(r);
    }
    // Rich MIME displays (display(), pandas, plotly, Markdown, audio, vídeo…).
    if (Array.isArray(out.displays)) for (const d of out.displays) renderDisplay(d, body, view);
    // Auto-captured matplotlib figures.
    if (Array.isArray(out.images)) for (const b64 of out.images) renderDisplay({ kind: 'image', data: b64 }, body, view);
    // A restored result whose figures were left out of the container to keep
    // the document light: say so rather than showing a silent gap.
    if (out.trimmed) {
      const note = document.createElement('div');
      note.className = 'out-note';
      note.textContent = '(figuras no guardadas en el documento — vuelve a ejecutar la celda para verlas)';
      body.appendChild(note);
    }

    row.appendChild(body);
    wrap.appendChild(row);
    return wrap;
  }
  ignoreEvent() { return true; }
}

/* ---------- Python syntax highlighting inside cells ----------
   The token palette itself lives in py-highlight.js, which parses the cell
   with the real Python grammar so calls, properties, types, parameters and
   constants can be told apart the way VSCode tells them apart. Here we only
   decide WHAT to tokenize: the cells that intersect the viewport. In a heavy
   document that turns per-keystroke work from O(all cells) into O(visible),
   and a cell is always tokenized whole, so partial visibility still colors
   correctly. */
function buildPythonDeco(view) {
  try {
    return buildPythonDecoUnsafe(view);
  } catch (_) {
    return Decoration.none; // never let the syntax overlay break the editor
  }
}

function buildPythonDecoUnsafe(view) {
  const state = view.state;
  const ranges = [];
  for (const cell of parseCells(state)) {
    const cellFrom = state.doc.line(cell.headerLine).from;
    const cellTo = state.doc.line(cell.endLine).to;
    const visible = view.visibleRanges.some((r) => r.to >= cellFrom && r.from <= cellTo);
    if (!visible) continue;
    if (cell.endLine - 1 < cell.headerLine + 1) continue;
    const from = state.doc.line(cell.headerLine + 1).from;
    const to = state.doc.line(cell.endLine - 1).to;
    const code = state.doc.sliceString(from, to);
    for (const m of classifyPythonCached(code)) {
      ranges.push(Decoration.mark({ class: m.cls }).range(from + m.from, from + m.to));
    }
  }
  return Decoration.set(ranges, true);
}
const pythonHighlight = ViewPlugin.fromClass(
  class {
    constructor(view) { this.decorations = buildPythonDeco(view); }
    update(u) {
      if (u.docChanged || u.viewportChanged) this.decorations = buildPythonDeco(u.view);
    }
  },
  { decorations: (v) => v.decorations }
);

/* ---------- output garbage collection ----------
   Outputs outlive the edit that produced them on purpose (you can rewrite a
   cell and still read what it printed), but a deleted cell's result is dead
   weight — and with figures attached, expensive dead weight. A debounced
   sweep drops everything whose cell no longer exists. */
const cellGc = ViewPlugin.fromClass(class {
  constructor(view) { this.view = view; this.timer = 0; }
  update(u) {
    if (!u.docChanged) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const st = this.view.state;
      gcDoc(docIdOf(st), new Set(parseCells(st).map(cellKey)));
    }, 4000);
  }
  destroy() { clearTimeout(this.timer); }
});

/* ---------- main decorations: hide markers, show toolbar/code/output ---------- */
// Which cell (if any) currently contains the cursor — gets the blue active bar.
function activeCellKey(state) {
  const ln = state.doc.lineAt(state.selection.main.head).number;
  const c = cellAtLine(parseCells(state), ln);
  return c ? cellKey(c) : null;
}

function buildDecorations(state) {
  try {
    return buildDecorationsUnsafe(state);
  } catch (_) {
    // A decoration set must NEVER throw out of a state-field update: CodeMirror
    // applies it inside EditorState.update, so an exception there corrupts the
    // whole transaction and can take the editor (and the app) down.
    return Decoration.none;
  }
}

function buildDecorationsUnsafe(state) {
  const cells = parseCells(state);
  const docId = docIdOf(state);
  const collapsed = state.field(collapsedCells);
  const outCollapsed = state.field(collapsedOutputs);
  const hidden = state.field(hideOutputsState);
  const active = activeCellKey(state);
  const doc = state.doc;
  const ranges = [];

  for (const cell of cells) {
    const key = cellKey(cell);
    const output = getOutput(docId, key);
    // A result produced by DIFFERENT code than the cell currently holds.
    const stale = !!(output && !output.running && output.codeHash
      && output.codeHash !== cell.codeHash);
    const isCollapsed = collapsed.has(key);
    const isActive = key === active;
    const header = doc.line(cell.headerLine);
    const end = doc.line(cell.endLine);
    const afterEnd = cell.endLine < doc.lines ? doc.line(cell.endLine + 1).from : end.to;

    // Toolbar replaces the %#python line's TEXT (inline replace that stays
    // within the marker line) so the first code line keeps its own decoration
    // and sits flush inside the cell. When collapsed it spans the code lines too.
    const hasCode = cell.endLine - 1 >= cell.headerLine + 1;
    const toolbarTo = isCollapsed && hasCode ? doc.line(cell.endLine - 1).to : header.to;
    // Collapse the marker lines' empty text height so the widget defines the row.
    ranges.push(Decoration.line({ class: 'cm-cell-shell' }).range(header.from));
    ranges.push(Decoration.line({ class: 'cm-cell-shell' }).range(end.from));
    ranges.push(
      Decoration.replace({ widget: new CellToolbar(cell, output, isCollapsed, isActive, stale) })
        .range(header.from, toolbarTo)
    );

    // Code lines (only when expanded) get the cell background.
    if (!isCollapsed) {
      for (let ln = cell.headerLine + 1; ln <= cell.endLine - 1; ln++) {
        const line = doc.line(ln);
        ranges.push(Decoration.line({ class: isActive ? 'cm-cell-code active' : 'cm-cell-code' }).range(line.from));
      }
    }

    // Output replaces the %#end line's text (inline), hiding the marker.
    ranges.push(
      Decoration.replace({
        widget: new CellOutput(key, output, isActive, hidden,
          outCollapsed.has(key), cell.headerLine, stale),
      }).range(end.from, end.to)
    );
  }
  return Decoration.set(ranges, true);
}

// The "which cell is active" tracker used to be a MODULE-level variable, so
// two panes showing the same document fought over it: moving the caret in one
// left the other's highlight stale. It belongs to the field's own value.
const cellDecorations = StateField.define({
  create: (state) => ({ deco: buildDecorations(state), active: activeCellKey(state) }),
  update(value, tr) {
    const fx = tr.effects.some((e) => e.is(refreshCells)
      || e.is(toggleCollapse) || e.is(toggleOutCollapse) || e.is(setHideOutputs)
      || e.is(setAllCollapse) || e.is(setAllOutCollapse));
    let active = value.active;
    let activeChanged = false;
    if (tr.selection || tr.docChanged) {
      const a = activeCellKey(tr.state);
      if (a !== active) { active = a; activeChanged = true; }
    }
    if (tr.docChanged || fx || activeChanged) {
      return { deco: buildDecorations(tr.state), active };
    }
    return { deco: value.deco.map(tr.changes), active };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

export const cellsExtension = [
  collapsedCells, collapsedOutputs, hideOutputsState, cellDecorations,
  pythonHighlight, cellGc,
];
