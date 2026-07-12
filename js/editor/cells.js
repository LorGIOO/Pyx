// VSCode/Jupyter-style Python cells embedded in a .tex document.
//
// A cell is the region between `%#python` and `%#end`. Both markers are LaTeX
// comments, so the file stays valid LaTeX — but Calc HIDES the markers entirely
// (they are replaced by the cell's toolbar and output blocks) so the editor
// looks exactly like a VSCode notebook cell. Typing the markers creates a cell;
// the cell is removed with its trash button (or by deleting the lines).

import { StateField, StateEffect } from '@codemirror/state';
import { EditorView, Decoration, WidgetType, ViewPlugin } from '@codemirror/view';
import { StringStream } from '@codemirror/language';
import { python } from '@codemirror/legacy-modes/mode/python';
import { state as appState } from '../core/state.js';
import { dirOf } from '../core/paths.js';
import { createVerbatimTracker } from '../compile/latex-bridge.js';
import { runCellCode, restartKernel, withKernelLock, interruptKernel } from './cell-runner.js';
import { broadcastCellRefresh } from './setup.js';
import { openExternal } from '../core/platform.js';

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

export const CELL_OPEN = '%#python';
export const CELL_CLOSE = '%#end';

let execCounter = 0; // notebook-style [1], [2], ...

/* ---------- per-cell output + collapsed state (keyed by code hash) ----------
   Outputs live in a MODULE-LEVEL map shared by every editor pane (splits show
   the same results); `refreshCells` is dispatched to each pane to repaint. */
const OUTPUTS = new Map(); // hash -> output object
export const refreshCells = StateEffect.define();
const toggleCollapse = StateEffect.define();    // collapse the cell's CODE
const toggleOutCollapse = StateEffect.define(); // collapse the cell's OUTPUT
// Collapse/expand EVERY cell at once (value: boolean). NOT the same as hiding
// outputs — the cells just fold to a thin cap and can be reopened individually.
const setAllCollapse = StateEffect.define();
const setAllOutCollapse = StateEffect.define();

export function getCellOutput(hash) {
  return OUTPUTS.get(hash);
}

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
          s = e.value ? new Set(parseCells(tr.state).map((c) => c.hash)) : new Set();
        }
      }
      return s;
    },
  });
}
const collapsedCells = makeToggleSet(toggleCollapse, setAllCollapse);
const collapsedOutputs = makeToggleSet(toggleOutCollapse, setAllOutCollapse);

// Fold (or unfold) every cell's CODE and OUTPUT in one shot, across all panes
// is handled by the caller; here we dispatch to one view.
export function collapseAllCells(view, collapsed) {
  if (!pyxActive()) return;
  view.dispatch({ effects: [setAllCollapse.of(collapsed), setAllOutCollapse.of(collapsed)] });
}

// When on, cell outputs collapse to a thin cap so the document takes less
// space — calculations still run and still compile into the PDF. Toggled from
// the "Cálculo" ribbon tab.
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
function hashCode(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return 'c' + (h >>> 0).toString(36);
}
function activeCwd() {
  return dirOf(appState.documents[appState.activeIndex]?.path);
}

// Memoized per document version (CodeMirror Text is immutable): decorations,
// highlighting and cursor tracking all call this on every keystroke, so the
// full-document scan must only happen once per edit, even in huge files.
const cellsCache = new WeakMap();

export function parseCells(state) {
  const doc = state.doc;
  const hit = cellsCache.get(doc);
  if (hit) return hit;
  const cells = [];
  // Markers inside verbatim environments (minted, verbatim, lstlisting…) are
  // DISPLAYED code, not cells — the tracker skips them. It only advances while
  // outside a cell (cell bodies are Python, not LaTeX).
  const inVerb = createVerbatimTracker();
  let inCell = false, headerLine = 0, codeLines = [];
  for (let ln = 1; ln <= doc.lines; ln++) {
    const raw = doc.line(ln).text;
    const verb = inCell ? false : inVerb(raw);
    const t = raw.trim();
    if (!inCell && !verb && t.startsWith(CELL_OPEN)) { inCell = true; headerLine = ln; codeLines = []; }
    else if (inCell && t.startsWith(CELL_CLOSE)) {
      const code = codeLines.join('\n');
      cells.push({ headerLine, endLine: ln, code, hash: hashCode(code) });
      inCell = false;
    } else if (inCell) codeLines.push(raw);
  }
  cellsCache.set(doc, cells);
  return cells;
}

export function parseCellsText(text) {
  const cells = [];
  const lines = text.split(/\r?\n/);
  const inVerb = createVerbatimTracker();
  let inCell = false, codeLines = [];
  for (const raw of lines) {
    const verb = inCell ? false : inVerb(raw);
    const t = raw.trim();
    if (!inCell && !verb && t.startsWith(CELL_OPEN)) { inCell = true; codeLines = []; }
    else if (inCell && t.startsWith(CELL_CLOSE)) { cells.push({ code: codeLines.join('\n') }); inCell = false; }
    else if (inCell) codeLines.push(raw);
  }
  return cells;
}

/* ---------- run / edit actions (re-parse by hash so edits stay consistent) ---------- */
// Internal executor — callers must hold the kernel lock. The lock keeps a cell
// run from slipping INTO another sequence (e.g. between the compile's kernel
// reset and its import cells), which produced phantom NameErrors (plt, np…).
async function execCell(view, cell, reset) {
  const prev = OUTPUTS.get(cell.hash) || {};
  OUTPUTS.set(cell.hash, { ...prev, running: true });
  broadcastCellRefresh();
  const t0 = performance.now();
  const res = await runCellCode(cell.code, { cwd: activeCwd(), reset });
  const ms = performance.now() - t0;
  const count = res.ok ? ++execCounter : prev.count || null;
  OUTPUTS.set(cell.hash, { ...res, running: false, count, ms });
  broadcastCellRefresh();
}
/* A MANUALLY run handcalcs cell (%%render/%%tex) IS document content: the PDF
   must show it right away, so a background compile fires automatically after
   the run. Debounced (run-all fires once at the end) and it retries while a
   compile is in flight. The compiler's own cell runs go through execCellByCode
   / runAllCellsHeld and never reach this — no compile loops. */
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

function runOne(view, cell, reset) {
  return withKernelLock(() => execCell(view, cell, reset)).then(() => {
    const out = OUTPUTS.get(cell.hash);
    if (out && out.ok && out.render) scheduleHandcalcsCompile();
  });
}
function runCellByHash(view, hash) {
  const cell = parseCells(view.state).find((c) => c.hash === hash);
  if (cell) runOne(view, cell, false);
}
function deleteCellByHash(view, hash) {
  const cell = parseCells(view.state).find((c) => c.hash === hash);
  if (!cell) return;
  const from = view.state.doc.line(cell.headerLine).from;
  const endLine = view.state.doc.line(cell.endLine);
  const to = cell.endLine < view.state.doc.lines ? view.state.doc.line(cell.endLine + 1).from : endLine.to;
  view.dispatch({ changes: { from, to, insert: '' } });
  view.focus();
}

export function runCellAtCursor(view) {
  if (!pyxActive()) return false;
  const ln = view.state.doc.lineAt(view.state.selection.main.head).number;
  const cell = parseCells(view.state).find((c) => ln >= c.headerLine && ln <= c.endLine);
  if (cell) { runOne(view, cell, false); return true; }
  return false;
}

// Shift+Enter, Jupyter-style: run the cell AND move the cursor below it. When
// the cell is the last line of the document, a new line is created so you can
// keep writing right away.
export function runCellAndAdvance(view) {
  if (!pyxActive()) return false;
  const ln = view.state.doc.lineAt(view.state.selection.main.head).number;
  const cell = parseCells(view.state).find((c) => ln >= c.headerLine && ln <= c.endLine);
  if (!cell) return false;
  runOne(view, cell, false);
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
// Run ONE cell identified by its code — through a view when the file is open
// (inline outputs update) or directly against the kernel otherwise. Used by
// the multi-file compiler. Callers must hold the kernel lock.
export async function execCellByCode(view, code, cwd) {
  if (view) {
    const cell = parseCells(view.state).find((c) => c.code === code);
    if (cell) {
      await execCell(view, cell, false);
      return OUTPUTS.get(cell.hash);
    }
  }
  return runCellCode(code, { cwd });
}

// Lock-free variant for callers that ALREADY hold the kernel lock (the
// compiler wraps cells + \py{} evaluation in ONE lock so nothing can slip in
// between them). Never call without holding the lock.
export async function runAllCellsHeld(view) {
  if (!pyxActive()) return;
  const cells = parseCells(view.state);
  for (let i = 0; i < cells.length; i++) await execCell(view, cells[i], i === 0);
}

export async function runAllCells(view) {
  if (!pyxActive()) return;
  if (!parseCells(view.state).length) return;
  // One lock for the WHOLE sequence: reset + every cell runs atomically, so a
  // concurrent Shift+Enter can never land between the reset and the imports.
  await withKernelLock(() => runAllCellsHeld(view));
  // If any cell produced a handcalcs render, refresh the PDF now (one compile
  // for the whole run, not one per cell).
  const any = parseCells(view.state).some((c) => {
    const o = OUTPUTS.get(c.hash);
    return o && o.ok && o.render;
  });
  if (any) scheduleHandcalcsCompile();
}

// Ctrl+A: inside a cell selects only the cell's code; otherwise returns false
// so the editor's default "select all" runs.
export function selectCellOrAll(view) {
  const ln = view.state.doc.lineAt(view.state.selection.main.head).number;
  const cell = parseCells(view.state).find((c) => ln >= c.headerLine && ln <= c.endLine);
  if (!cell || cell.endLine - 1 < cell.headerLine + 1) return false;
  const from = view.state.doc.line(cell.headerLine + 1).from;
  const to = view.state.doc.line(cell.endLine - 1).to;
  view.dispatch({ selection: { anchor: from, head: to } });
  return true;
}
export function clearCellOutputs() {
  OUTPUTS.clear();
  broadcastCellRefresh();
}
// New cells are EMPTY with the caret already inside (Ctrl+Alt+C), so you can
// start typing instantly without clicking into the cell.
export function insertCellTemplate(view) {
  if (!pyxActive()) return; // cells exist only in .pltx documents
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const prefix = line.length ? '\n' : '';
  const snippet = `${prefix}${CELL_OPEN}\n\n${CELL_CLOSE}\n`;
  view.dispatch({
    changes: { from: line.to, insert: snippet },
    selection: { anchor: line.to + prefix.length + CELL_OPEN.length + 1 },
  });
  view.focus();
}

/* ---------- icons (VSCode codicon-like) ---------- */
const I = {
  compile: '<svg viewBox="0 0 16 16"><path d="M4 2.5v11l9-5.5z"/></svg>',
  trash: '<svg viewBox="0 0 16 16"><path d="M3 4h10M6 4V2.7h4V4M5 4l.7 9h4.6L11 4z" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
  chevronDown: '<svg viewBox="0 0 16 16"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
  chevronRight: '<svg viewBox="0 0 16 16"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
  expand: '<svg viewBox="0 0 16 16"><path d="M2.5 6V2.5H6M14 6V2.5h-3.5M2.5 10v3.5H6M14 10v3.5h-3.5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
  stop: '<svg viewBox="0 0 16 16"><rect x="4" y="4" width="8" height="8" rx="1.2" fill="currentColor"/></svg>',
};

function iconBtn(cls, svg, title, onClick) {
  const b = document.createElement('button');
  b.className = 'cell-ico ' + cls;
  b.innerHTML = svg;
  b.title = title;
  b.onmousedown = (e) => e.preventDefault();
  b.onclick = (e) => { e.stopPropagation(); onClick(); };
  return b;
}

// Small "open in detached viewer" button shown on figures and tables.
function expandBtn(title, onClick) {
  const b = document.createElement('button');
  b.className = 'cell-expand';
  b.innerHTML = I.expand;
  b.title = title;
  b.onmousedown = (e) => e.preventDefault();
  b.onclick = (e) => { e.stopPropagation(); onClick(); };
  return b;
}

/* ---------- toolbar widget (replaces the %#python line, hiding it) ---------- */
class CellToolbar extends WidgetType {
  constructor(cell, output, collapsed, active) {
    super();
    this.cell = cell;
    this.hash = cell.hash;
    this.output = output;
    this.collapsed = collapsed;
    this.active = active;
  }
  eq(o) {
    return o.hash === this.hash && o.output === this.output && o.collapsed === this.collapsed
      && o.active === this.active && o.cell.code === this.cell.code;
  }
  toDOM(view) {
    const out = this.output || {};
    const bar = document.createElement('div');
    bar.className = 'cell-bar' + (this.collapsed ? ' collapsed' : '') + (this.active ? ' active' : '');
    bar.contentEditable = 'false';

    const left = document.createElement('div');
    left.className = 'cell-bar-left';
    left.appendChild(iconBtn('collapse', this.collapsed ? I.chevronRight : I.chevronDown,
      this.collapsed ? 'Expandir' : 'Contraer',
      () => view.dispatch({ effects: toggleCollapse.of(this.hash) })));

    const count = document.createElement('span');
    count.className = 'cell-count';
    count.textContent = out.running ? '[*]' : out.count ? `[${out.count}]` : '[ ]';
    left.appendChild(count);

    if (this.collapsed) {
      const preview = document.createElement('span');
      preview.className = 'cell-preview';
      const first = (this.cell.code.split('\n').find((l) => l.trim()) || '').trim();
      const n = this.cell.code.split('\n').length;
      preview.textContent = first ? `${first}  ⋯ (${n} líneas)` : `(${n} líneas)`;
      left.appendChild(preview);
    } else {
      const status = document.createElement('span');
      status.className = 'cell-status';
      if (out.running) { status.classList.add('running'); status.textContent = 'Ejecutando…'; }
      else if (out.ok === true) { status.classList.add('ok'); status.textContent = '✓'; }
      else if (out.ok === false) { status.classList.add('err'); status.textContent = '✗ error'; }
      left.appendChild(status);
    }
    bar.appendChild(left);

    const right = document.createElement('div');
    right.className = 'cell-bar-right';
    // Jupyter-style: the cell's play button RUNS this cell; WHILE running it
    // turns into a STOP (■) button that interrupts the kernel (no LaTeX compile,
    // so pure-Python documents work with no document/save needed). Whole-document
    // compile lives in the ribbon / title bar ("Compilar y ver").
    if (out.running) {
      right.appendChild(iconBtn('run stop', I.stop, 'Interrumpir la ejecución', () => interruptKernel()));
    } else {
      right.appendChild(iconBtn('run', I.compile, 'Ejecutar la celda (Mayús+Intro)', () => runCellByHash(view, this.hash)));
    }
    right.appendChild(iconBtn('danger', I.trash, 'Eliminar celda', () => deleteCellByHash(view, this.hash)));
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

// Theme-aware HTML wrapper so iframe content follows the app's light/dark theme.
function richSrcdoc(inner) {
  const css = getComputedStyle(document.documentElement);
  const v = (n, fb) => (css.getPropertyValue(n) || fb).trim();
  const fg = v('--theme-cell-output-text', '#dddddd');
  const accent = v('--theme-cell-accent', '#3794ff');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:transparent;color:${fg};
      font:13px "Segoe UI",system-ui,sans-serif;overflow:hidden}
    body{padding:2px}
    .pyx-katex{overflow-x:auto;overflow-y:hidden}
    .katex-display{margin:4px 0}
    a{color:${accent}}
  </style></head><body>${inner}</body></html>`;
}

// Interactive HTML (plotly/3D and the KaTeX of handcalcs) rendered INLINE in an
// auto-sized iframe so its <script> tags actually run — `innerHTML` never
// executes scripts, which is why these used to show only a redirect placeholder.
// The frame grows to fit its content (no inner scrollbar); the expand button
// still opens it in its own tab/window like any other figure.
function renderInteractive(d, body, view) {
  const holder = document.createElement('div');
  holder.className = 'out-rich-holder';
  holder.appendChild(expandBtn('Abrir en otra ventana', () => openHtmlTab(d.data)));
  const frame = document.createElement('iframe');
  frame.className = 'out-iframe';
  frame.setAttribute('scrolling', 'no');
  frame.srcdoc = richSrcdoc(d.data);
  const fit = () => {
    try {
      const docu = frame.contentDocument;
      if (!docu || !docu.body) return;
      // Shrink-then-measure: documentElement.scrollHeight is never SMALLER
      // than the iframe viewport, so measuring at the current height means the
      // frame could only ever grow — handcalcs/KaTeX outputs ended up with a
      // tall blank gap below. Collapse first so scrollHeight = content height.
      frame.style.height = '8px';
      const h = docu.body.scrollHeight;
      frame.style.height = (h ? h + 4 : 24) + 'px';
      view.requestMeasure();
    } catch (_) { /* same-origin guard */ }
  };
  frame.addEventListener('load', () => {
    fit();
    // plotly/3D/KaTeX draw asynchronously after load → re-measure a few times.
    [120, 400, 900, 1600].forEach((t) => setTimeout(fit, t));
    try { new ResizeObserver(fit).observe(frame.contentDocument.body); } catch (_) {}
    // Links inside the output open in the system browser, never in-app.
    try {
      frame.contentDocument.addEventListener('click', (e) => {
        const a = e.target.closest && e.target.closest('a[href]');
        const href = a && a.getAttribute('href');
        if (href && /^https?:\/\//i.test(href)) { e.preventDefault(); openExternal(href); }
      }, true);
    } catch (_) { /* cross-origin guard */ }
  });
  holder.appendChild(frame);
  body.appendChild(holder);
}

// One rich MIME display entry (from the kernel router) → DOM. Figures and
// interactive outputs render IN PLACE and can also be opened in their own tab.
function renderDisplay(d, body, view) {
  if (d.kind === 'image') {
    const src = 'data:image/png;base64,' + d.data;
    const fig = document.createElement('div');
    fig.className = 'out-fig';
    fig.appendChild(expandBtn('Abrir en otra ventana', () => openImageTab(src)));
    const img = document.createElement('img');
    img.onload = () => view.requestMeasure();
    img.src = src;
    fig.appendChild(img);
    body.appendChild(fig);
    return;
  }
  // Script-bearing HTML (plotly, 3D, handcalcs KaTeX) must run its scripts:
  // render it inline in an iframe instead of a non-functional innerHTML.
  if (d.kind === 'html' && /<script[\s>]/i.test(d.data)) {
    renderInteractive(d, body, view);
    return;
  }
  // Static rich output (SVG, pandas tables, video/audio markup): inline, themed.
  const holder = document.createElement('div');
  holder.className = 'out-rich-holder';
  holder.appendChild(expandBtn('Abrir en otra ventana', () => openHtmlTab(d.data)));
  const rich = document.createElement('div');
  rich.className = 'out-rich';
  rich.innerHTML = d.data;
  holder.appendChild(rich);
  body.appendChild(holder);
}

// Map cell-relative line numbers inside an error message to DOCUMENT lines
// ("unterminated string literal (detected at line 65)" → the real editor line).
function mapMsgLines(msg, headerLine) {
  return String(msg || '').replace(/\b(line|línea)\s+(\d+)/gi,
    (a, w, n) => `${w} ${headerLine + +n}`);
}

// Jupyter/VSCode-style COLORED traceback: each part gets its own color —
// location (clickable link to the exact document line), function names, the
// offending source line, the green ^ caret and the bold error type.
function renderTraceback(err, headerLine, body, view) {
  const jump = (docLine) => {
    const n = Math.min(docLine, view.state.doc.lines);
    const line = view.state.doc.line(n);
    view.dispatch({
      selection: { anchor: line.from },
      effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
    });
    view.focus();
  };
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
      ln.onclick = () => jump(headerLine + relLine);
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
  constructor(hash, output, active, hidden, outCollapsed, headerLine) {
    super();
    this.hash = hash; this.output = output; this.active = active;
    this.hidden = hidden; this.outCollapsed = outCollapsed; this.headerLine = headerLine;
  }
  eq(o) {
    return o.hash === this.hash && o.output === this.output && o.active === this.active
      && o.hidden === this.hidden && o.outCollapsed === this.outCollapsed
      && o.headerLine === this.headerLine;
  }
  toDOM(view) {
    const out = this.output || {};
    const wrap = document.createElement('div');
    wrap.contentEditable = 'false';

    // handcalcs (%%render / %%tex) cells: the calculation IS visible here
    // (KaTeX display) and, when a LaTeX document exists, it ALSO compiles into
    // the PDF in place of the cell.
    if (out.render && !this.hidden) {
      wrap.className = 'cell-out render-note' + (this.active ? ' active' : '');
      const g = document.createElement('div'); g.className = 'cell-out-gutter'; g.textContent = out.count ? `[${out.count}]` : '';
      const b = document.createElement('div'); b.className = 'cell-out-body';
      if (Array.isArray(out.displays)) for (const d of out.displays) renderDisplay(d, b, view);
      wrap.appendChild(g); wrap.appendChild(b);
      return wrap;
    }

    const hasContent = out.stdout || out.stderr || out.error ||
      (out.result != null && out.result !== '') ||
      (Array.isArray(out.displays) && out.displays.length) ||
      (Array.isArray(out.images) && out.images.length);
    const has = !this.hidden && hasContent;
    wrap.className = 'cell-out' + (has ? '' : ' empty') + (this.active ? ' active' : '');
    if (!has) return wrap;

    // Output minimized (independent of the code collapse): slim clickable strip.
    if (this.outCollapsed) {
      wrap.classList.add('out-collapsed');
      const gutter = document.createElement('div');
      gutter.className = 'cell-out-gutter';
      gutter.appendChild(iconBtn('collapse', I.chevronRight, 'Expandir salida',
        () => view.dispatch({ effects: toggleOutCollapse.of(this.hash) })));
      wrap.appendChild(gutter);
      const body = document.createElement('div');
      body.className = 'cell-out-body slim';
      body.textContent = `··· salida oculta${out.ms != null ? ` (${fmtMs(out.ms)})` : ''}`;
      body.onmousedown = (e) => e.preventDefault();
      body.onclick = () => view.dispatch({ effects: toggleOutCollapse.of(this.hash) });
      wrap.appendChild(body);
      return wrap;
    }

    const gutter = document.createElement('div');
    gutter.className = 'cell-out-gutter';
    gutter.appendChild(iconBtn('collapse', I.chevronDown, 'Minimizar salida',
      () => view.dispatch({ effects: toggleOutCollapse.of(this.hash) })));
    const cnt = document.createElement('div');
    cnt.className = 'out-count';
    cnt.textContent = out.count ? `[${out.count}]` : '';
    gutter.appendChild(cnt);
    if (out.ms != null) {
      // Execution time, bottom-left corner of the cell.
      const t = document.createElement('div');
      t.className = 'cell-time';
      t.title = 'Tiempo de ejecución de la celda';
      t.textContent = fmtMs(out.ms);
      gutter.appendChild(t);
    }
    wrap.appendChild(gutter);

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
      chip.onclick = () => {
        const n = Math.min(docLine, view.state.doc.lines);
        const line = view.state.doc.line(n);
        view.dispatch({
          selection: { anchor: line.from },
          effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
        });
        view.focus();
      };
      body.appendChild(chip);
    }
    // Colored, clickable traceback (Jupyter/VSCode-style) from the structured
    // error; stderr then only carries what the USER printed to it.
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

    wrap.appendChild(body);
    return wrap;
  }
  ignoreEvent() { return true; }
}

/* ---------- Python syntax highlighting inside cells ----------
   Categorize tokens exactly like VSCode's Dark+/Light+ (control keywords vs
   storage vs builtins vs types vs constants vs self), driving the --py-* vars. */
const CONTROL = new Set(['import', 'from', 'as', 'for', 'while', 'if', 'elif', 'else', 'try',
  'except', 'finally', 'with', 'return', 'yield', 'raise', 'break', 'continue', 'pass', 'in',
  'is', 'not', 'and', 'or', 'assert', 'del', 'async', 'await', 'match', 'case']);
const STORAGE = new Set(['def', 'class', 'lambda', 'global', 'nonlocal']);
const CONSTS = new Set(['True', 'False', 'None', 'NotImplemented', 'Ellipsis', '__debug__']);
const SELF = new Set(['self', 'cls']);
const PYTYPES = new Set(['int', 'float', 'str', 'list', 'dict', 'set', 'tuple', 'bool', 'bytes',
  'bytearray', 'complex', 'frozenset', 'object', 'type', 'memoryview']);

function pyClass(style, text) {
  if (!style) return null;
  const s = style.split(/[ .-]/)[0];
  switch (s) {
    case 'keyword':
      if (CONTROL.has(text)) return 'cm-py-control';
      if (STORAGE.has(text)) return 'cm-py-storage';
      if (CONSTS.has(text)) return 'cm-py-atom';
      return 'cm-py-keyword';
    case 'builtin':
      return PYTYPES.has(text) ? 'cm-py-type' : 'cm-py-builtin';
    case 'def': return 'cm-py-func';
    case 'variable':
      return SELF.has(text) ? 'cm-py-self' : 'cm-py-variable';
    case 'property': return 'cm-py-property';
    case 'string': return 'cm-py-string';
    case 'number': return 'cm-py-number';
    case 'comment': return 'cm-py-comment';
    case 'operator': return 'cm-py-operator';
    case 'meta': return 'cm-py-decorator';
    case 'atom': return CONSTS.has(text) ? 'cm-py-atom' : 'cm-py-variable';
    default: return null;
  }
}

// Only tokenize the cells that intersect the viewport: in a heavy document
// with many cells this turns per-keystroke work from O(all cells) into
// O(visible cells). A cell is tokenized whole (Python state starts fresh at
// its first line), so partial visibility still highlights correctly.
function buildPythonDeco(view) {
  const state = view.state;
  const ranges = [];
  for (const cell of parseCells(state)) {
    const cellFrom = state.doc.line(cell.headerLine).from;
    const cellTo = state.doc.line(cell.endLine).to;
    const visible = view.visibleRanges.some((r) => r.to >= cellFrom && r.from <= cellTo);
    if (!visible) continue;
    let ps = python.startState ? python.startState(4) : {};
    for (let ln = cell.headerLine + 1; ln <= cell.endLine - 1; ln++) {
      const line = state.doc.line(ln);
      if (line.length === 0) { python.blankLine && python.blankLine(ps, 4); continue; }
      const stream = new StringStream(line.text, 4, 4);
      let guard = 0;
      while (!stream.eol() && guard++ < 5000) {
        stream.start = stream.pos;
        const style = python.token(stream, ps);
        const from = line.from + stream.start, to = line.from + stream.pos;
        if (stream.pos === stream.start) { stream.next(); continue; }
        if (style && to > from) {
          const cls = pyClass(style, line.text.slice(stream.start, stream.pos));
          if (cls) ranges.push(Decoration.mark({ class: cls }).range(from, to));
        }
      }
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

/* ---------- main decorations: hide markers, show toolbar/code/output ---------- */
// Which cell (if any) currently contains the cursor — gets the blue active bar.
function activeCellHash(state) {
  const ln = state.doc.lineAt(state.selection.main.head).number;
  const c = parseCells(state).find((c) => ln >= c.headerLine && ln <= c.endLine);
  return c ? c.hash : null;
}

function buildDecorations(state) {
  const cells = parseCells(state);
  const collapsed = state.field(collapsedCells);
  const outCollapsed = state.field(collapsedOutputs);
  const hidden = state.field(hideOutputsState);
  const active = activeCellHash(state);
  const doc = state.doc;
  const ranges = [];

  for (const cell of cells) {
    const output = OUTPUTS.get(cell.hash);
    const isCollapsed = collapsed.has(cell.hash);
    const isActive = cell.hash === active;
    const header = doc.line(cell.headerLine);
    const end = doc.line(cell.endLine);
    const afterHeader = doc.line(cell.headerLine + 1).from; // start of first code line
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
      Decoration.replace({ widget: new CellToolbar(cell, output, isCollapsed, isActive) })
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
        widget: new CellOutput(cell.hash, output, isActive, hidden,
          outCollapsed.has(cell.hash), cell.headerLine),
      }).range(end.from, end.to)
    );
  }
  return Decoration.set(ranges, true);
}

let lastActive = null;
const cellDecorations = StateField.define({
  create: (state) => buildDecorations(state),
  update(deco, tr) {
    const fx = tr.effects.some((e) => e.is(refreshCells)
      || e.is(toggleCollapse) || e.is(toggleOutCollapse) || e.is(setHideOutputs)
      || e.is(setAllCollapse) || e.is(setAllOutCollapse));
    // Rebuild when the active cell changes (cursor crossed a cell boundary).
    let activeChanged = false;
    if (tr.selection || tr.docChanged) {
      const a = activeCellHash(tr.state);
      if (a !== lastActive) { lastActive = a; activeChanged = true; }
    }
    if (tr.docChanged || fx || activeChanged) return buildDecorations(tr.state);
    return deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

export const cellsExtension = [collapsedCells, collapsedOutputs, hideOutputsState, cellDecorations, pythonHighlight];
