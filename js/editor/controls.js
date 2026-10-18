// Interactive controls in Python cells — MATLAB live-script controls, written
// as a comment so the cell stays plain Python:
//
//   L = 6.0        # @slider(1, 12, 0.5) Luz de la viga (m)
//   q = 10         # @input Carga (kN/m)
//   perfil = "IPE" # @select("IPE", "HEB", "UPN")
//   fisurada = True # @check
//
// The editor shows the control at the end of the line. Moving it rewrites the
// value in the code — the document always says what was computed — and, when
// it is released, runs the cell; with reactive execution the cells that
// depend on it run too, and only those. The same controls are listed in the
// side panel's "Parámetros" tab (CalcTree's parameter panel).

import { WidgetType, Decoration, ViewPlugin, EditorView } from '@codemirror/view';
import { parseCells } from './cell-parse.js';

const KINDS = 'slider|input|number|select|check|text';
const CONTROL_RE = new RegExp(
  `^(\\s*)([A-Za-z_]\\w*)(\\s*=\\s*)(.+?)(\\s*#\\s*@(${KINDS})\\b(?:\\(([^)]*)\\))?\\s*(.*))$`,
);

/** Split control arguments on commas outside quotes, as JS values. */
function parseArgs(src) {
  if (!src || !src.trim()) return [];
  const out = [];
  let cur = '', q = null;
  for (const ch of src) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === ',') { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.map(literal);
}

/** A Python literal as a JS value (number, string, boolean), or undefined. */
function literal(s) {
  const t = String(s).trim();
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return Number(t);
  const m = /^(['"])(.*)\1$/.exec(t);
  if (m) return m[2];
  if (t === 'True') return true;
  if (t === 'False') return false;
  return undefined;
}

/**
 * The control declared on a line, or null.
 * @returns {{name:string, kind:string, args:any[], label:string, value:any, raw:string,
 *            valueFrom:number, valueTo:number, quote:string}|null}
 */
export function parseControlLine(text) {
  const m = CONTROL_RE.exec(text);
  if (!m) return null;
  const [, indent, name, eq, raw, , kind, args, label] = m;
  const value = literal(raw);
  if (value === undefined) return null; // an expression, not a value to tweak
  const valueFrom = indent.length + name.length + eq.length;
  return {
    name, kind: kind === 'number' ? 'input' : kind, args: parseArgs(args), label: label.trim(), value, raw,
    valueFrom, valueTo: valueFrom + raw.length, quote: (/^(['"])/.exec(raw.trim()) || [, '"'])[1],
  };
}

/** Slider bounds: the declared ones, or sensible ones around the value. */
export function sliderRange(c) {
  const v = typeof c.value === 'number' ? c.value : 0;
  const [min = Math.min(0, v), max = v > 0 ? v * 2 : 10, step] = c.args.filter((a) => typeof a === 'number');
  const s = step || (Number.isInteger(v) && Number.isInteger(min) && Number.isInteger(max) ? 1 : (max - min) / 100);
  return { min, max, step: s };
}

/** The literal to write back for a new value. */
export function formatValue(c, v) {
  if (c.kind === 'check') return v ? 'True' : 'False';
  if (typeof c.value === 'string' || c.kind === 'select' || c.kind === 'text') {
    const q = c.quote || '"';
    return q + String(v).replace(/\\/g, '\\\\').replace(new RegExp(q, 'g'), `\\${q}`) + q;
  }
  const n = Number(v);
  if (!Number.isFinite(n)) return c.raw;
  if (c.kind === 'slider') {
    // As many decimals as the step has: 0.5 → 7.5, never 7.500000001.
    const { step } = sliderRange(c);
    const dec = (String(step).split('.')[1] || '').length;
    return dec ? n.toFixed(dec) : String(Math.round(n));
  }
  // Keep a float a float (6.0 stays 6.0 when set to 7).
  return /\./.test(c.raw) && Number.isInteger(n) ? n.toFixed(1) : String(n);
}

/** Every control in the cells of an EditorState: [{line, from, ...control}]. */
export function controlsOf(state) {
  const out = [];
  for (const cell of parseCells(state)) {
    for (let ln = cell.headerLine + 1; ln < cell.endLine; ln++) {
      const line = state.doc.line(ln);
      if (line.text.indexOf('@') < 0) continue;
      const c = parseControlLine(line.text);
      if (c) out.push({ ...c, line: ln, from: line.from, cell });
    }
  }
  return out;
}

/** Write a new value for the control on line `ln`. Returns the control. */
export function setControlValue(view, ln, v) {
  const line = view.state.doc.line(ln);
  const c = parseControlLine(line.text);
  if (!c) return null;
  const insert = formatValue(c, v);
  if (insert === c.raw) return c;
  view.dispatch({
    changes: { from: line.from + c.valueFrom, to: line.from + c.valueTo, insert },
    userEvent: 'input.control',
  });
  return c;
}

/* ---------- running after a change ----------
   A control released while its cell is still running queues ONE more run
   (with the latest value), never a backlog of one run per movement. */
const inflight = new Map(); // cell header line → { again }
export async function runControlCell(view, ln) {
  const cells = parseCells(view.state);
  const cell = cells.find((c) => ln > c.headerLine && ln < c.endLine);
  if (!cell) return;
  const key = cell.id || cell.headerLine;
  const cur = inflight.get(key);
  if (cur) { cur.again = true; return; }
  const entry = { again: false };
  inflight.set(key, entry);
  try {
    const { runCellAt } = await import('./cells.js');
    do {
      entry.again = false;
      const pos = view.state.doc.line(Math.min(ln, view.state.doc.lines)).from;
      await runCellAt(view, pos);
    } while (entry.again);
  } finally {
    inflight.delete(key);
  }
}

/** The DOM of a control (shared by the editor widget and the side panel). */
export function controlDom(c, { onInput, onChange }) {
  const wrap = document.createElement('span');
  wrap.className = `pyx-ctl pyx-ctl-${c.kind}`;
  const stop = (e) => e.stopPropagation();
  if (c.kind === 'slider') {
    const { min, max, step } = sliderRange(c);
    const r = document.createElement('input');
    r.type = 'range'; r.min = min; r.max = max; r.step = step; r.value = c.value;
    const out = document.createElement('span');
    out.className = 'pyx-ctl-val';
    out.textContent = formatValue(c, c.value);
    r.addEventListener('input', () => { out.textContent = formatValue(c, r.value); onInput && onInput(r.value); });
    r.addEventListener('change', () => onChange(r.value));
    r.addEventListener('mousedown', stop);
    wrap.append(r, out);
  } else if (c.kind === 'check') {
    const b = document.createElement('input');
    b.type = 'checkbox'; b.checked = !!c.value;
    b.addEventListener('mousedown', stop);
    b.addEventListener('change', () => onChange(b.checked));
    wrap.append(b);
  } else if (c.kind === 'select') {
    const s = document.createElement('select');
    const opts = c.args.length ? c.args : [c.value];
    for (const o of opts) {
      const op = document.createElement('option');
      op.value = String(o); op.textContent = String(o);
      if (String(o) === String(c.value)) op.selected = true;
      s.append(op);
    }
    s.addEventListener('mousedown', stop);
    s.addEventListener('change', () => onChange(opts.find((o) => String(o) === s.value) ?? s.value));
    wrap.append(s);
  } else {
    const i = document.createElement('input');
    const numeric = typeof c.value === 'number';
    i.type = numeric ? 'number' : 'text';
    if (numeric && c.args.length >= 2) { i.min = c.args[0]; i.max = c.args[1]; if (c.args[2]) i.step = c.args[2]; } else if (numeric) i.step = 'any';
    i.value = c.value;
    i.addEventListener('mousedown', stop);
    i.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); onChange(numeric ? Number(i.value) : i.value); }
    });
    i.addEventListener('change', () => onChange(numeric ? Number(i.value) : i.value));
    wrap.append(i);
  }
  return wrap;
}

class ControlWidget extends WidgetType {
  constructor(c, ln) { super(); this.c = c; this.ln = ln; }
  eq(o) { return o.c.kind === this.c.kind && o.c.raw === this.c.raw && o.c.name === this.c.name && JSON.stringify(o.c.args) === JSON.stringify(this.c.args); }
  updateDOM(dom) {
    // Same control, new value typed in the code: update in place (never
    // rebuild the DOM under a slider being dragged).
    const input = dom.querySelector('input, select');
    if (!input || input === document.activeElement) return true;
    if (input.type === 'checkbox') input.checked = !!this.c.value; else input.value = this.c.value;
    const out = dom.querySelector('.pyx-ctl-val');
    if (out) out.textContent = formatValue(this.c, this.c.value);
    return true;
  }
  toDOM(view) {
    const lineOf = (dom) => { try { return view.state.doc.lineAt(view.posAtDOM(dom)).number; } catch (_) { return this.ln; } };
    let dom;
    dom = controlDom(this.c, {
      onInput: (v) => setControlValue(view, lineOf(dom), v),
      onChange: (v) => { const ln = lineOf(dom); setControlValue(view, ln, v); runControlCell(view, ln); },
    });
    dom.title = this.c.label || `@${this.c.kind}`;
    return dom;
  }
  ignoreEvent() { return true; }
}

function buildControls(view) {
  const ranges = [];
  for (const c of controlsOf(view.state)) {
    const line = view.state.doc.line(c.line);
    ranges.push(Decoration.widget({ widget: new ControlWidget(c, c.line), side: 1 }).range(line.to));
  }
  return Decoration.set(ranges, true);
}

export const cellControls = [
  ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = buildControls(view); }
    update(u) { if (u.docChanged) this.decorations = buildControls(u.view); }
  }, { decorations: (v) => v.decorations }),
  EditorView.baseTheme({}),
];
