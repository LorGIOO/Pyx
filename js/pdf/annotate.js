// PDF review layer: the markup a corrector needs, like a desktop PDF viewer's
// comment tools — highlight, underline and strike-through ON THE WORDS YOU
// SELECT, a smoothed pen and a marker, line, arrow, rectangle and ellipse,
// comment notes written in place, an eraser, a select tool to move or delete
// a mark, undo/redo, and the list of corrections copied as text.
//
// Coordinates are PDF POINTS of each page (its own size at scale 1, origin at
// the top-left), so every mark scales with zoom and survives the page being
// re-rasterized. Each page draws an <svg> overlay (rebuilt on every render);
// the data lives in `store`, persisted per PDF path in localStorage.

import { annotTool, annotColor, annotWidth } from '../solid/stores/previewStore.js';

const SVGNS = 'http://www.w3.org/2000/svg';
/** Tools that act on a text selection instead of drawing. */
export const TEXT_TOOLS = new Set(['texthl', 'underline', 'strike']);

let store = {};            // pageNumber -> [annotation]
let docKey = null;         // localStorage key for the current PDF
const sizes = new Map();   // pageNumber -> { w, h } in points
const layers = new Map();  // pageNumber -> live <svg> (the marks, and the events)
// pageNumber -> <svg> UNDER it where highlights MULTIPLY with the page, like
// ink on paper: the words under a highlight stay black and crisp. Everything
// else is drawn normally (a comment box must hide what it covers).
const inks = new Map();
const isInk = (a) => a.t === 'highlight' || (a.t === 'mark' && a.k === 'hl');
let selected = null;       // the mark picked with the select tool
let undoStack = [];
let redoStack = [];

/** Point a new PDF at the layer: load its saved annotations (or none). */
export function setAnnotDoc(path) {
  docKey = path ? 'pyx-annot:' + path : null;
  store = {};
  if (docKey) {
    try { store = JSON.parse(localStorage.getItem(docKey) || '{}') || {}; } catch (_) { store = {}; }
  }
  layers.clear();
  inks.clear();
  sizes.clear();
  selected = null;
  undoStack = [];
  redoStack = [];
}

function persist() {
  if (!docKey) return;
  try {
    if (Object.keys(store).length) localStorage.setItem(docKey, JSON.stringify(store));
    else localStorage.removeItem(docKey);
  } catch (_) { /* quota / private mode */ }
}

/* ---------- history ---------- */
function snapshot() {
  undoStack.push(JSON.stringify(store));
  if (undoStack.length > 200) undoStack.shift();
  redoStack = [];
}
function restore(from, to) {
  if (!from.length) return;
  to.push(JSON.stringify(store));
  store = JSON.parse(from.pop());
  selected = null;
  persist();
  redrawAll();
}
export const undo = () => restore(undoStack, redoStack);
export const redo = () => restore(redoStack, undoStack);
export const undoLast = undo;
export function clearPage(n) {
  if (!store[n]) return;
  snapshot();
  delete store[n];
  persist();
  redraw(n);
}
function removeMark(n, a) {
  const arr = store[n];
  if (!arr) return;
  const i = arr.indexOf(a);
  if (i >= 0) arr.splice(i, 1);
  if (!arr.length) delete store[n];
}

/* ---------- geometry (pure: unit-tested) ---------- */
const r2 = (v) => Math.round(v * 100) / 100;

/** A smooth path through freehand points: quadratic curves through the
 *  midpoints, so a pen stroke reads as ink, not as a polyline. */
export function smoothPath(p) {
  if (p.length < 2) return '';
  if (p.length < 6) {
    let d = `M${r2(p[0])} ${r2(p[1])}`;
    for (let i = 2; i + 1 < p.length; i += 2) d += ` L${r2(p[i])} ${r2(p[i + 1])}`;
    return p.length === 2 ? d + ' h0.01' : d;
  }
  let d = `M${r2(p[0])} ${r2(p[1])}`;
  for (let i = 2; i + 3 < p.length; i += 2) {
    d += ` Q${r2(p[i])} ${r2(p[i + 1])} ${r2((p[i] + p[i + 2]) / 2)} ${r2((p[i + 1] + p[i + 3]) / 2)}`;
  }
  return d + ` L${r2(p[p.length - 2])} ${r2(p[p.length - 1])}`;
}

/** The rectangles of a text selection ([x, y, w, h], points) merged into one
 *  per line: a selection gives one box per text run, and highlighting each
 *  separately left darker seams where they overlap. */
export function mergeLineRects(rects) {
  // Left to right: runs of one line sit at slightly different heights (a
  // different font, a sub/superscript), so sorting by y would interleave them.
  const rs = rects.filter((r) => r[2] > 0.3 && r[3] > 0.3).map((r) => [...r]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const r of rs) {
    const line = out.find((o) => {
      const top = Math.max(o[1], r[1]);
      const bottom = Math.min(o[1] + o[3], r[1] + r[3]);
      return bottom - top > 0.5 * Math.min(o[3], r[3]) && r[0] - (o[0] + o[2]) < 0.8 * Math.max(o[3], r[3]);
    });
    if (!line) { out.push(r); continue; }
    const x0 = Math.min(line[0], r[0]);
    const y0 = Math.min(line[1], r[1]);
    const x1 = Math.max(line[0] + line[2], r[0] + r[2]);
    const y1 = Math.max(line[1] + line[3], r[1] + r[3]);
    line.splice(0, 4, x0, y0, x1 - x0, y1 - y0);
  }
  return out.sort((a, b) => a[1] - b[1] || a[0] - b[0]).map((r) => r.map(r2));
}

/** Bounding box [x0, y0, x1, y1] of a mark (for hit testing and selection). */
export function bbox(a) {
  const pad = (a.w || 0) / 2;
  if (a.pts) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i + 1 < a.pts.length; i += 2) {
      x0 = Math.min(x0, a.pts[i]); x1 = Math.max(x1, a.pts[i]);
      y0 = Math.min(y0, a.pts[i + 1]); y1 = Math.max(y1, a.pts[i + 1]);
    }
    return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
  }
  if (a.rects) {
    const xs = a.rects.flatMap((r) => [r[0], r[0] + r[2]]);
    const ys = a.rects.flatMap((r) => [r[1], r[1] + r[3]]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  if (a.t === 'note') return [a.x - 7, a.y - 7, a.x + 7 + noteWidth(a), a.y + noteHeight(a)];
  if (a.t === 'text') return [a.x, a.y - a.s, a.x + a.str.length * a.s * 0.6, a.y + a.s * 0.3];
  return [Math.min(a.x0, a.x1) - pad, Math.min(a.y0, a.y1) - pad, Math.max(a.x0, a.x1) + pad, Math.max(a.y0, a.y1) + pad];
}
const NOTE_FONT = 8.5; // points
const noteLines = (a) => String(a.str || ' ').split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / 38)), 0);
const noteWidth = (a) => Math.min(190, Math.max(60, Math.max(...String(a.str || ' ').split('\n').map((l) => l.length)) * NOTE_FONT * 0.55 + 14));
const noteHeight = (a) => noteLines(a) * NOTE_FONT * 1.3 + 8;

function distToSeg(px, py, x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - x0) * dx + (py - y0) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
}
/** Is (x, y) on the mark, within `tol` points? */
export function hitTest(a, x, y, tol) {
  if (a.pts) {
    for (let i = 0; i + 3 < a.pts.length; i += 2) {
      if (distToSeg(x, y, a.pts[i], a.pts[i + 1], a.pts[i + 2], a.pts[i + 3]) <= tol + a.w / 2) return true;
    }
    return a.pts.length >= 2 && Math.hypot(x - a.pts[0], y - a.pts[1]) <= tol + a.w / 2;
  }
  if (a.rects) return a.rects.some((r) => x >= r[0] - tol && x <= r[0] + r[2] + tol && y >= r[1] - tol && y <= r[1] + r[3] + tol);
  if (a.t === 'line' || a.t === 'arrow') return distToSeg(x, y, a.x0, a.y0, a.x1, a.y1) <= tol + a.w / 2;
  if (a.t === 'rect') {
    const [lx, ty, rx, by] = [Math.min(a.x0, a.x1), Math.min(a.y0, a.y1), Math.max(a.x0, a.x1), Math.max(a.y0, a.y1)];
    const nearV = x >= lx - tol && x <= rx + tol;
    const nearH = y >= ty - tol && y <= by + tol;
    return (nearH && (Math.abs(x - lx) <= tol || Math.abs(x - rx) <= tol))
      || (nearV && (Math.abs(y - ty) <= tol || Math.abs(y - by) <= tol));
  }
  if (a.t === 'ellipse') {
    const cx = (a.x0 + a.x1) / 2, cy = (a.y0 + a.y1) / 2;
    const rx = Math.max(0.5, Math.abs(a.x1 - a.x0) / 2), ry = Math.max(0.5, Math.abs(a.y1 - a.y0) / 2);
    return Math.abs(Math.hypot((x - cx) / rx, (y - cy) / ry) - 1) * Math.min(rx, ry) <= tol + a.w / 2;
  }
  const b = bbox(a);
  return x >= b[0] - tol && x <= b[2] + tol && y >= b[1] - tol && y <= b[3] + tol;
}
function moveMark(a, dx, dy) {
  if (a.pts) for (let i = 0; i + 1 < a.pts.length; i += 2) { a.pts[i] += dx; a.pts[i + 1] += dy; }
  else if (a.rects) for (const r of a.rects) { r[0] += dx; r[1] += dy; }
  else if ('x0' in a) { a.x0 += dx; a.x1 += dx; a.y0 += dy; a.y1 += dy; }
  else { a.x += dx; a.y += dy; }
}

/* ---------- rendering ---------- */
function el(tag, attrs, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}
const stroke = (a, extra = {}) => ({
  fill: 'none', stroke: a.c, 'stroke-width': a.w, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', ...extra,
});

function renderAnnot(a) {
  if (a.t === 'pen') return el('path', stroke(a, { d: smoothPath(a.pts) }));
  // A marker and a text highlight MULTIPLY with the page, like ink on paper:
  // the words under them stay black and crisp, never washed out.
  if (a.t === 'highlight') {
    return el('path', stroke(a, { d: smoothPath(a.pts), 'stroke-opacity': 0.45 }));
  }
  if (a.t === 'mark') {
    const g = el('g', {});
    for (const [x, y, w, h] of a.rects) {
      if (a.k === 'hl') el('rect', { x, y, width: w, height: h, rx: Math.min(1.5, h / 6), fill: a.c, 'fill-opacity': 0.45 }, g);
      else {
        const yy = a.k === 'ul' ? y + h * 0.94 : y + h * 0.56;
        el('line', { x1: x, y1: yy, x2: x + w, y2: yy, stroke: a.c, 'stroke-width': Math.max(0.8, h * 0.08), 'stroke-linecap': 'round' }, g);
      }
    }
    return g;
  }
  if (a.t === 'rect') {
    return el('rect', stroke(a, {
      x: Math.min(a.x0, a.x1), y: Math.min(a.y0, a.y1), width: Math.abs(a.x1 - a.x0), height: Math.abs(a.y1 - a.y0), rx: 1.5,
    }));
  }
  if (a.t === 'ellipse') {
    return el('ellipse', stroke(a, {
      cx: (a.x0 + a.x1) / 2, cy: (a.y0 + a.y1) / 2, rx: Math.abs(a.x1 - a.x0) / 2, ry: Math.abs(a.y1 - a.y0) / 2,
    }));
  }
  if (a.t === 'line' || a.t === 'arrow') {
    const g = el('g', {});
    let { x1, y1 } = a;
    if (a.t === 'arrow') {
      // A filled head, its shaft stopping at the head's base so a thick line
      // never pokes through the tip.
      const len = Math.hypot(a.x1 - a.x0, a.y1 - a.y0) || 1;
      const ux = (a.x1 - a.x0) / len, uy = (a.y1 - a.y0) / len;
      const L = Math.min(len, Math.max(7, a.w * 4)), W = L * 0.62;
      const bx = a.x1 - ux * L, by = a.y1 - uy * L;
      el('path', {
        d: `M${r2(a.x1)} ${r2(a.y1)} L${r2(bx - uy * W / 2)} ${r2(by + ux * W / 2)} L${r2(bx + uy * W / 2)} ${r2(by - ux * W / 2)} Z`,
        fill: a.c, stroke: a.c, 'stroke-width': Math.min(a.w, 1.2), 'stroke-linejoin': 'round',
      }, g);
      x1 = bx + ux * 0.5; y1 = by + uy * 0.5;
    }
    el('line', stroke(a, { x1: a.x0, y1: a.y0, x2: x1, y2: y1 }), g);
    return g;
  }
  if (a.t === 'note') {
    const g = el('g', { class: 'annot-note' });
    // The marker: a small speech bubble in the note's colour at the spot.
    el('path', {
      d: `M${a.x - 6} ${a.y - 6} h12 a1.5 1.5 0 0 1 1.5 1.5 v6.5 a1.5 1.5 0 0 1 -1.5 1.5 h-6.5 l-3.5 3 v-3 h-2 a1.5 1.5 0 0 1 -1.5 -1.5 v-6.5 a1.5 1.5 0 0 1 1.5 -1.5 z`,
      fill: a.c, stroke: 'rgba(0,0,0,0.25)', 'stroke-width': 0.5,
    }, g);
    if (a.str) {
      const fo = el('foreignObject', { x: a.x + 10, y: a.y - 6, width: noteWidth(a) + 4, height: noteHeight(a) + 4 }, g);
      const box = document.createElement('div');
      box.className = 'annot-note-box';
      box.style.setProperty('--note', a.c);
      box.style.fontSize = NOTE_FONT + 'px';
      box.textContent = a.str;
      fo.appendChild(box);
    }
    return g;
  }
  if (a.t === 'text') { // notes of earlier versions: plain text on the page
    const t = el('text', { x: a.x, y: a.y, fill: a.c, 'font-size': a.s, 'font-family': 'Segoe UI, system-ui, sans-serif' });
    t.textContent = a.str;
    return t;
  }
  return el('g', {});
}

function redraw(n, svg) {
  svg = svg || layers.get(n);
  if (!svg) return;
  const all = store[n] || [];
  const ink = inks.get(n);
  if (ink) ink.replaceChildren(...all.filter(isInk).map(renderAnnot));
  svg.replaceChildren(...all.filter((a) => !ink || !isInk(a)).map(renderAnnot));
  if (selected && selected.n === n && (store[n] || []).includes(selected.a)) {
    const [x0, y0, x1, y1] = bbox(selected.a);
    el('rect', {
      x: x0 - 3, y: y0 - 3, width: x1 - x0 + 6, height: y1 - y0 + 6, rx: 2,
      class: 'annot-selection', 'vector-effect': 'non-scaling-stroke',
    }, svg);
  }
}
function redrawAll() { for (const n of layers.keys()) redraw(n); }
const sizeOf = (n) => sizes.get(n) || sizes.values().next().value || { w: 612, h: 792 };

/* ---------- notes, written in place ---------- */
function editNote(n, a, content, isNew) {
  const { w, h } = sizeOf(n);
  const ta = document.createElement('textarea');
  ta.className = 'annot-note-editor';
  ta.value = a.str || '';
  ta.placeholder = 'Comentario… (Ctrl+Intro para terminar, Esc cancela)';
  ta.style.left = `${((a.x + 10) / w) * 100}%`;
  ta.style.top = `${((a.y - 6) / h) * 100}%`;
  ta.style.setProperty('--note', a.c);
  content.appendChild(ta);
  let done = false;
  // keep = commit what was typed (an emptied note goes); otherwise cancel.
  // The snapshot taken before editing is dropped when nothing changed.
  const finish = (keep) => {
    if (done) return;
    done = true;
    const str = ta.value.replace(/\s+$/, '');
    ta.remove();
    const changed = keep && str !== (a.str || '');
    if (keep && str) a.str = str;
    else if (isNew || keep) removeMark(n, a);
    if (!changed && !(keep && !str && !isNew)) undoStack.pop();
    persist();
    redraw(n);
  };
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation(); // the editor's and the app's shortcuts stay out of it
    if (e.key === 'Escape') finish(false);
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) finish(true);
  });
  ta.addEventListener('pointerdown', (e) => e.stopPropagation());
  ta.addEventListener('blur', () => finish(true));
  requestAnimationFrame(() => ta.focus());
}

/* ---------- text markup from the selection ---------- */
/** With highlight / underline / strike-through active, turn the text the user
 *  just selected into that mark (one per page it spans). True if it did. */
export function markupFromSelection() {
  const tool = annotTool();
  if (!TEXT_TOOLS.has(tool)) return false;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return false;
  const range = sel.getRangeAt(0);
  const pages = [...document.querySelectorAll('.pdf-page')].map((p) => ({ p, r: p.getBoundingClientRect() }));
  const byPage = new Map();
  for (const r of range.getClientRects()) {
    if (r.width < 1 || r.height < 1) continue;
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const hit = pages.find(({ r: pr }) => cx >= pr.left && cx <= pr.right && cy >= pr.top && cy <= pr.bottom);
    if (!hit) continue;
    const n = +hit.p.dataset.page;
    const { w, h } = sizeOf(n);
    const kx = w / hit.r.width, ky = h / hit.r.height;
    if (!byPage.has(n)) byPage.set(n, []);
    byPage.get(n).push([(r.left - hit.r.left) * kx, (r.top - hit.r.top) * ky, r.width * kx, r.height * ky]);
  }
  if (!byPage.size) return false;
  snapshot();
  const txt = sel.toString().replace(/\s+/g, ' ').trim().slice(0, 600);
  const k = tool === 'texthl' ? 'hl' : tool === 'underline' ? 'ul' : 'st';
  for (const [n, rects] of byPage) {
    (store[n] || (store[n] = [])).push({ t: 'mark', k, c: annotColor(), rects: mergeLineRects(rects), txt });
    redraw(n);
  }
  persist();
  try { sel.removeAllRanges(); } catch (_) { /* nothing selected any more */ }
  return true;
}

/* ---------- the list of corrections ---------- */
const LABEL = {
  hl: 'Resaltado', ul: 'Subrayado', st: 'Tachado', note: 'Comentario', text: 'Nota', pen: 'Trazo',
  highlight: 'Rotulador', line: 'Línea', arrow: 'Flecha', rect: 'Recuadro', ellipse: 'Elipse',
};
/** Every mark of the document as one line of text, page by page. */
export function correctionsText() {
  const lines = [];
  for (const n of Object.keys(store).map(Number).sort((x, y) => x - y)) {
    for (const a of store[n]) {
      const what = LABEL[a.t === 'mark' ? a.k : a.t] || a.t;
      const body = a.t === 'mark' ? `: «${a.txt || ''}»` : a.str ? `: ${a.str.replace(/\s*\n\s*/g, ' / ')}` : '';
      lines.push(`Pág. ${n} · ${what}${body}`);
    }
  }
  return lines.join('\n');
}

/* ---------- keyboard: Supr, Esc, Ctrl+Z / Ctrl+Y while reviewing ---------- */
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => {
    if (!annotTool()) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'z') { undo(); }
    else if (mod && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { redo(); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
      snapshot();
      removeMark(selected.n, selected.a);
      const n = selected.n;
      selected = null;
      persist();
      redraw(n);
    } else if (e.key === 'Escape' && selected) {
      const n = selected.n;
      selected = null;
      redraw(n);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  }, true);
}

/* ---------- drawing ---------- */
function newAnnot(tool, x, y, color, w) {
  if (tool === 'highlight') return { t: 'highlight', c: color, w: w * 5, pts: [x, y] };
  if (['rect', 'ellipse', 'arrow', 'line'].includes(tool)) return { t: tool, c: color, w, x0: x, y0: y, x1: x, y1: y };
  return { t: 'pen', c: color, w, pts: [x, y] };
}
function isEmpty(a) {
  if (a.pts) return a.pts.length < 4;
  return Math.abs(a.x1 - a.x0) < 2 && Math.abs(a.y1 - a.y0) < 2;
}
function topHit(n, x, y) {
  const arr = store[n] || [];
  for (let i = arr.length - 1; i >= 0; i--) if (hitTest(arr[i], x, y, 4)) return arr[i];
  return null;
}

/** Build (and wire) a page's annotation overlay; `w`×`h` is the page's size
 *  in points. Called every time the page is (re)rendered. */
export function buildAnnotLayer(n, content, w, h) {
  if (w && h) sizes.set(n, { w, h });
  const { w: W, h: H } = sizeOf(n);
  const ink = el('svg', { class: 'pdf-annotlayer pdf-annotink', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none' });
  const svg = el('svg', { class: 'pdf-annotlayer', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none' });
  layers.set(n, svg);
  inks.set(n, ink);
  redraw(n, svg);

  const toPt = (e) => {
    const r = svg.getBoundingClientRect();
    return [
      Math.max(0, Math.min(W, ((e.clientX - r.left) / r.width) * W)),
      Math.max(0, Math.min(H, ((e.clientY - r.top) / r.height) * H)),
    ];
  };
  let cur = null;      // the mark being drawn
  let drag = null;     // moving the selected mark
  let erasing = null;  // { erased } during an eraser stroke
  let lastTap = null;  // { t, a }: a second press on the same note edits it
  const capture = (e) => { try { svg.setPointerCapture(e.pointerId); } catch (_) { /* gone */ } };
  const erase = (x, y) => {
    const a = topHit(n, x, y);
    if (!a) return;
    removeMark(n, a);
    erasing.erased = true;
    redraw(n, svg);
  };

  svg.addEventListener('pointerdown', (e) => {
    const tool = annotTool();
    if (!tool || TEXT_TOOLS.has(tool) || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const [x, y] = toPt(e);
    if (tool === 'eraser') {
      snapshot();
      erasing = { erased: false };
      erase(x, y);
      capture(e);
      return;
    }
    if (tool === 'select') {
      const a = topHit(n, x, y);
      const prev = selected && selected.n;
      selected = a ? { n, a } : null;
      if (prev && prev !== n) redraw(prev);
      redraw(n, svg);
      const again = a && lastTap && lastTap.a === a && e.timeStamp - lastTap.t < 450;
      lastTap = a ? { t: e.timeStamp, a } : null;
      if (a) {
        if (again && a.t === 'note') { snapshot(); editNote(n, a, content, false); return; }
        snapshot();
        drag = { x, y, moved: false };
        capture(e);
      }
      return;
    }
    if (tool === 'note') {
      const a = topHit(n, x, y);
      if (a && a.t === 'note') { snapshot(); editNote(n, a, content, false); return; }
      snapshot();
      const note = { t: 'note', c: annotColor(), x, y, str: '' };
      (store[n] || (store[n] = [])).push(note);
      redraw(n, svg);
      editNote(n, note, content, true);
      return;
    }
    snapshot();
    cur = newAnnot(tool, x, y, annotColor(), annotWidth());
    (store[n] || (store[n] = [])).push(cur);
    capture(e);
    redraw(n, svg);
  });
  svg.addEventListener('pointermove', (e) => {
    if (!cur && !drag && !erasing) return;
    e.preventDefault();
    e.stopPropagation();
    const [x, y] = toPt(e);
    if (erasing) { erase(x, y); return; }
    if (drag) {
      moveMark(selected.a, x - drag.x, y - drag.y);
      drag = { x, y, moved: true };
      redraw(n, svg);
      return;
    }
    if (cur.pts) {
      // Points closer than half a point add nothing but weight.
      const px = cur.pts[cur.pts.length - 2], py = cur.pts[cur.pts.length - 1];
      if (Math.hypot(x - px, y - py) >= 0.5) cur.pts.push(r2(x), r2(y));
    } else {
      // Shift: a horizontal / vertical / 45° line, or a square / circle.
      let ex = x, ey = y;
      if (e.shiftKey) {
        const dx = x - cur.x0, dy = y - cur.y0;
        if (cur.t === 'line' || cur.t === 'arrow') {
          const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), len = Math.hypot(dx, dy);
          ex = cur.x0 + len * Math.cos(ang); ey = cur.y0 + len * Math.sin(ang);
        } else {
          const s = Math.max(Math.abs(dx), Math.abs(dy));
          ex = cur.x0 + Math.sign(dx || 1) * s; ey = cur.y0 + Math.sign(dy || 1) * s;
        }
      }
      cur.x1 = r2(ex);
      cur.y1 = r2(ey);
    }
    redraw(n, svg);
  });
  const end = (e) => {
    if (erasing) {
      if (!erasing.erased) undoStack.pop();
      erasing = null;
      persist();
    } else if (drag) {
      if (!drag.moved) undoStack.pop();
      drag = null;
      persist();
    } else if (cur) {
      if (isEmpty(cur)) { removeMark(n, cur); undoStack.pop(); }
      cur = null;
      persist();
      redraw(n, svg);
    } else return;
    try { svg.releasePointerCapture(e.pointerId); } catch (_) { /* gone */ }
  };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);

  content.append(ink, svg);
  return svg;
}
