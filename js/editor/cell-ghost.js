// The value of each \celda{…}, in faint grey right after it in the editor —
// like the ghost of a \py{} — read straight from the workbook, without
// compiling. A cell that cannot be read says why (in the same place), so an
// empty spot in the PDF never goes unexplained.
//
// The workbook is the one of the \hoja in force at that point of the file;
// paths are relative to the main document, as for the compile. Rust keeps
// each workbook parsed while it does not change (sheets.rs), so reading again
// after every edit — or when coming back from Excel — costs next to nothing.

import { ViewPlugin, Decoration, WidgetType } from '@codemirror/view';
import { StateEffect } from '@codemirror/state';
import { findSheetCommands, parseCellOptions, gridTeX } from '../compile/sheets.js';
import { isTauri, sheetValues } from '../core/platform.js';
import { joinPath, dirOf } from '../core/paths.js';
import { state as appState } from '../core/state.js';
import { docIdOf } from './doc-id.js';
import { general } from '../solid/stores/settingsStore.js';
import { t } from '../core/i18n.js';

const refresh = StateEffect.define();
// "abs path|sheet|ref" -> { ok, text } | { ok: false, error }
const cache = new Map();

/** LaTeX of a value, made readable: \, -> thin space, {,} -> comma… */
function plain(tex) {
  return String(tex)
    .replace(/\\ensuremath\{([\s\S]*)\}/g, '$1')
    .replace(/\\times/g, '×').replace(/\\,/g, ' ').replace(/\{,\}/g, ',')
    .replace(/\\%/g, '%').replace(/\\([&$#_{}])/g, '$1')
    .replace(/\\textbackslash\{\}/g, '\\')
    .replace(/\\\\/g, '⏎').replace(/\s*&\s*/g, ' │ ')
    .replace(/\\[a-zA-Z]+\{([^{}]*)\}/g, '$1');
}

class Ghost extends WidgetType {
  constructor(text, bad) { super(); this.text = text; this.bad = bad; }
  eq(o) { return o.text === this.text && o.bad === this.bad; }
  toDOM() {
    const s = document.createElement('span');
    s.className = this.bad ? 'cm-py-ghost cm-cell-ghost-bad' : 'cm-py-ghost cm-cell-ghost';
    s.textContent = this.bad ? ` ⚠ ${this.text}` : ` = ${this.text}`;
    s.title = this.bad ? this.text : t('Ctrl+clic: abrir en Excel', 'Ctrl+click: open in Excel');
    return s;
  }
  ignoreEvent() { return true; }
}

const rootDirOf = new Map(); // doc id -> main document folder

function cellsIn(view) {
  const text = view.state.doc.toString();
  if (text.indexOf('\\celda') < 0) return [];
  let link = null;
  const out = [];
  for (const c of findSheetCommands(text)) {
    if (c.kind === 'hoja') link = { path: c.arg, sheet: c.opt };
    else out.push({ ...c, link });
  }
  return out;
}

function keyOf(base, c) {
  if (!c.link || !c.link.path) return null;
  const p = /^([a-zA-Z]:[\\/]|\/)/.test(c.link.path) ? c.link.path : (base ? joinPath(base, c.link.path) : null);
  return p ? `${p}\u0000${c.link.sheet || ''}\u0000${c.arg}` : null;
}

function decos(view) {
  if (general.pyGhost === false || !isTauri()) return Decoration.none;
  const base = rootDirOf.get(docIdOf(view.state));
  const b = [];
  for (const c of cellsIn(view)) {
    const k = keyOf(base, c);
    if (!c.link) {
      b.push(Decoration.widget({ widget: new Ghost(t('falta un \\hoja{libro.xlsx} antes', 'a \\hoja{workbook.xlsx} is missing before it'), true), side: 1 }).range(c.end));
      continue;
    }
    const v = k && cache.get(k);
    if (!v) continue;
    if (!v.ok) { b.push(Decoration.widget({ widget: new Ghost(v.error, true), side: 1 }).range(c.end)); continue; }
    const o = parseCellOptions(c.opt);
    const empty = v.grid.every((row) => row.every((x) => x == null || x === ''));
    let txt = empty ? '' : plain(gridTeX(v.grid, o.transpose, o));
    if (empty) { b.push(Decoration.widget({ widget: new Ghost(t('celda vacía', 'empty cell'), true), side: 1 }).range(c.end)); continue; }
    if (txt.length > 40) txt = txt.slice(0, 38) + '…';
    b.push(Decoration.widget({ widget: new Ghost(txt, false), side: 1 }).range(c.end));
  }
  return Decoration.set(b, true);
}

async function load(view) {
  if (!isTauri()) return;
  const cells = cellsIn(view);
  if (!cells.length) return;
  const id = docIdOf(view.state);
  const doc = appState.documents.find((d) => d.id === id);
  let base = doc && doc.path ? dirOf(doc.path) : null;
  try {
    const m = await import('../compile/compiler.js');
    if (doc && appState.documents[appState.activeIndex] === doc) base = (await m.activeRootDir()) || base;
  } catch (_) { /* keep the document's folder */ }
  rootDirOf.set(id, base);
  // One request per workbook and sheet.
  const groups = new Map();
  for (const c of cells) {
    const k = keyOf(base, c);
    if (!k) continue;
    const [file, sheet] = k.split('\u0000');
    const g = `${file}\u0000${sheet}`;
    if (!groups.has(g)) groups.set(g, new Set());
    groups.get(g).add(c.arg);
  }
  let changed = false;
  await Promise.all([...groups].map(async ([g, refs]) => {
    const [file, sheet] = g.split('\u0000');
    const list = [...refs];
    let res;
    try { res = await sheetValues(file, sheet || null, list); } catch (e) { res = list.map(() => ({ ok: false, error: String((e && e.message) || e) })); }
    list.forEach((ref, i) => {
      const k = `${file}\u0000${sheet}\u0000${ref}`;
      const v = res[i] || { ok: false, error: '?' };
      const prev = cache.get(k);
      if (!prev || JSON.stringify(prev) !== JSON.stringify(v)) { cache.set(k, v); changed = true; }
    });
  }));
  if (changed) { try { view.dispatch({ effects: refresh.of(null) }); } catch (_) { /* destroyed */ } }
}

export const cellGhost = ViewPlugin.fromClass(class {
  constructor(view) {
    this.decorations = decos(view);
    this.timer = 0;
    this.view = view;
    this.onFocus = () => this.schedule(100); // back from Excel
    window.addEventListener('focus', this.onFocus);
    this.schedule(50);
  }
  update(u) {
    if (u.docChanged || u.transactions.some((tr) => tr.effects.some((e) => e.is(refresh)))) this.decorations = decos(u.view);
    if (u.docChanged) this.schedule(600);
  }
  schedule(ms) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => load(this.view), ms);
  }
  destroy() { clearTimeout(this.timer); window.removeEventListener('focus', this.onFocus); }
}, { decorations: (v) => v.decorations });
