// "Ghost" results in the editor: the computed value of each \py{EXPR} is shown
// in faint gray right after it, live and WITHOUT compiling (Mathcad / MATLAB
// Live Editor style). Values come from the kernel's CURRENT namespace, so they
// refresh as you run cells — the editor becomes semi-live.

import { ViewPlugin, Decoration, WidgetType } from '@codemirror/view';
import { StateEffect } from '@codemirror/state';
import { findPyExprs } from '../compile/latex-bridge.js';
import { dirOf } from '../core/paths.js';
import { evalExpressions } from './cell-runner.js';
import { parseCells, cellAtLine } from './cells.js';
import { state as appState } from '../core/state.js';
import { general } from '../solid/stores/settingsStore.js';

// expr -> { ok, value }. Module-level so every pane shares the same values.
const cache = new Map();
const refreshGhost = StateEffect.define();

/**
 * The \py{…} occurrences inside the VISIBLE part of the document.
 *
 * The old version scanned the entire document (`doc.toString()` + a full
 * findPyExprs pass) on every keystroke, then built a ghost widget for every
 * occurrence in the file. Ghosts are only ever *seen* in the viewport, and the
 * values are only ever *needed* for what's on screen — so scanning the whole
 * document was pure waste that grew with file size. We now scan only the
 * visible ranges (plus a little slack so scrolling doesn't flicker).
 *
 * Positions are returned in absolute document coordinates.
 */
function visiblePyExprs(view) {
  const doc = view.state.doc;
  const out = [];
  for (const r of view.visibleRanges) {
    // Pad to whole lines so a \py{…} straddling the viewport edge is still found.
    const from = doc.lineAt(r.from).from;
    const to = doc.lineAt(r.to).to;
    const chunk = doc.sliceString(from, to);
    for (const e of findPyExprs(chunk)) {
      out.push({ start: from + e.start, end: from + e.end, expr: e.expr });
    }
  }
  return out;
}

class GhostWidget extends WidgetType {
  constructor(text) { super(); this.text = text; }
  eq(o) { return o.text === this.text; }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-py-ghost';
    s.textContent = ' = ' + this.text;
    return s;
  }
  ignoreEvent() { return true; }
}

function ghostDecos(view) {
  if (general.pyGhost === false) return Decoration.none;
  const exprs = visiblePyExprs(view);
  if (!exprs.length) return Decoration.none;
  const cells = parseCells(view.state);
  // Bisect instead of scanning the cell list per occurrence (that was O(exprs ×
  // cells)). A \py{} inside a cell body is Python, not a document reference.
  const inCell = (pos) => {
    const c = cellAtLine(cells, view.state.doc.lineAt(pos).number);
    return !!c && pos > view.state.doc.line(c.headerLine).to
      && pos < view.state.doc.line(c.endLine).from;
  };
  const b = [];
  for (const e of exprs) {
    if (inCell(e.start)) continue;
    const v = cache.get(e.expr);
    if (!v || !v.ok) continue;
    let val = String(v.value);
    if (val.length > 28) val = val.slice(0, 26) + '…';
    b.push(Decoration.widget({ widget: new GhostWidget(val), side: 1 }).range(e.end));
  }
  return Decoration.set(b, true);
}

export const pyGhost = ViewPlugin.fromClass(class {
  constructor(view) {
    this.decorations = ghostDecos(view);
    this.timer = 0;
    this.evaluate(view);
  }
  update(u) {
    if (u.docChanged || u.viewportChanged
      || u.transactions.some((tr) => tr.effects.some((ef) => ef.is(refreshGhost)))) {
      this.decorations = ghostDecos(u.view);
    }
    if (u.docChanged) this.schedule(u.view);
  }
  schedule(view) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.evaluate(view), 500);
  }
  destroy() { clearTimeout(this.timer); }
  async evaluate(view) {
    if (general.pyGhost === false) return;
    // Only when the kernel is ALREADY alive (never auto-start for a preview) and
    // no compile is mid-flight (its cell sequence must not be disturbed).
    if (appState.kernelStatus !== 'ready' || appState.compiling) return;
    const d = appState.documents[appState.activeIndex];
    if (!d || d.kind) return;
    // Only documents that actually have cells — a pure .tex has no kernel values.
    if (!parseCells(view.state).length) return;
    // Evaluate only what can actually be shown (the viewport), not every \py{}
    // in the file: on a thousand-page document that was thousands of kernel
    // round-trips for values nobody could see.
    const exprs = [...new Set(visiblePyExprs(view).map((e) => e.expr))];
    if (!exprs.length) return;
    const res = await evalExpressions(exprs, { cwd: d.path ? dirOf(d.path) : undefined, silent: true });
    let changed = false;
    for (const x of exprs) {
      const v = res[x] || { ok: false, value: '' };
      const prev = cache.get(x);
      if (!prev || prev.ok !== v.ok || prev.value !== v.value) { cache.set(x, v); changed = true; }
    }
    if (changed) { try { view.dispatch({ effects: refreshGhost.of(null) }); } catch (_) { /* destroyed */ } }
  }
}, { decorations: (v) => v.decorations });
