// "Ghost" results in the editor: the computed value of each \py{EXPR} is shown
// in faint gray right after it, live and WITHOUT compiling (Mathcad / MATLAB
// Live Editor style). Values come from the kernel's CURRENT namespace, so they
// refresh as you run cells — the editor becomes semi-live.

import { ViewPlugin, Decoration, WidgetType } from '@codemirror/view';
import { StateEffect } from '@codemirror/state';
import { findPyExprs } from '../compile/latex-bridge.js';
import { dirOf } from '../core/paths.js';
import { evalExpressions } from './cell-runner.js';
import { parseCells } from './cells.js';
import { state as appState } from '../core/state.js';
import { general } from '../solid/stores/settingsStore.js';

// expr -> { ok, value }. Module-level so every pane shares the same values.
const cache = new Map();
const refreshGhost = StateEffect.define();

// \py{} scan memoized per immutable doc (same trick as parseCells), so the live
// rebuild on every keystroke stays cheap even in long documents.
const exprCache = new WeakMap();
function pyExprsOf(state) {
  const hit = exprCache.get(state.doc);
  if (hit) return hit;
  const r = findPyExprs(state.doc.toString());
  exprCache.set(state.doc, r);
  return r;
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
  const exprs = pyExprsOf(view.state);
  if (!exprs.length) return Decoration.none;
  const cells = parseCells(view.state);
  const inCell = (pos) => {
    const ln = view.state.doc.lineAt(pos).number;
    return cells.some((c) => ln > c.headerLine && ln < c.endLine);
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
    const exprs = [...new Set(pyExprsOf(view.state).map((e) => e.expr))];
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
