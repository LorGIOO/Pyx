// PDF review layer: the markup a corrector needs, like a desktop PDF viewer's
// comment tools — highlight, underline and strike-through ON THE WORDS YOU
// SELECT, a smoothed pen and a marker, lines and arrows (straight, curved or
// elbowed), rectangles and ellipses, text boxes and comment notes written in
// place, an eraser (whole marks, or only the part it touches), a laser
// pointer that fades by itself, a select tool that moves, RESIZES and
// reshapes a mark by its handles, undo/redo, and the list of corrections.
//
// Coordinates are PDF POINTS of each page (its own size at scale 1, origin at
// the top-left), so every mark scales with zoom and survives the page being
// re-rasterized. Each page draws an <svg> overlay (rebuilt on every render);
// the data lives in `store`, persisted per PDF path in localStorage. The
// shapes themselves are described in annot-geom.js (pure, unit-tested), which
// the PDF export reads too.

import {
  annotTool, annotColor, annotWidth, annotLineKind, annotHeads, annotDash, annotRound, annotEraser, annotFont,
  setAnnotColor, setAnnotWidth, setAnnotLineKind, setAnnotHeads, setAnnotDash, setAnnotRound, setAnnotFont,
  setAnnotSel,
} from '../solid/stores/previewStore.js';
import {
  r2, markPaths, bbox, hitTest, moveMark, handlesOf, applyHandle, snapAngle, eraseAt, headsOf, mergeLineRects,
  noteWidth, noteHeight, tboxHeight, NOTE_FONT, onNoteIcon,
} from './annot-geom.js';

export { mergeLineRects, smoothPath, hitTest, bbox } from './annot-geom.js';

const SVGNS = 'http://www.w3.org/2000/svg';
/** Tools that act on a text selection instead of drawing. */
export const TEXT_TOOLS = new Set(['texthl', 'underline', 'strike']);
/** Tools whose pointer is a circle the size of their tip. */
const BRUSH_TOOLS = new Set(['pen', 'highlight', 'eraser', 'laser']);

let store = {};            // pageNumber -> [annotation]
let docKey = null;         // localStorage key for the current PDF
const sizes = new Map();   // pageNumber -> { w, h } in points
const layers = new Map();  // pageNumber -> live <svg> (the marks, and the events)
// pageNumber -> <svg> UNDER it where highlights MULTIPLY with the page, like
// ink on paper: the words under a highlight stay black and crisp. Everything
// else is drawn normally (a comment box must hide what it covers).
const inks = new Map();
const isInk = (a) => a.t === 'highlight' || (a.t === 'mark' && a.k === 'hl');
let selected = null;       // { n, a }: the mark picked with the select tool
let editing = null;        // the text box being typed in (not drawn meanwhile)
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
  setSelected(null);
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

/** Are there marks on this PDF? (The viewer asks before exporting.) */
export const hasAnnotations = () => Object.values(store).some((arr) => arr && arr.length);
/** A copy of every mark, by page, with each page's size as the viewer knows
 *  it: what the PDF export draws. */
export function annotationData() {
  return {
    marks: JSON.parse(JSON.stringify(store)),
    sizes: Object.fromEntries([...sizes].map(([n, s]) => [n, { ...s }])),
  };
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
  setSelected(null);
  persist();
  redrawAll();
}
export const undo = () => restore(undoStack, redoStack);
export const redo = () => restore(redoStack, undoStack);
export const undoLast = undo;

/** Remove every mark of page `n`. True when there was something to remove. */
export function clearPage(n) {
  if (!store[n] || !store[n].length) return false;
  snapshot();
  delete store[n];
  if (selected && selected.n === n) setSelected(null);
  persist();
  redraw(n);
  return true;
}
/** Remove every mark of the document (one undo step brings them back). */
export function clearAll() {
  if (!hasAnnotations()) return false;
  snapshot();
  store = {};
  setSelected(null);
  persist();
  redrawAll();
  return true;
}
/** Pages that carry marks, in order. */
export const annotatedPages = () => Object.keys(store).filter((n) => store[n] && store[n].length).map(Number).sort((a, b) => a - b);

function removeMark(n, a) {
  const arr = store[n];
  if (!arr) return;
  const i = arr.indexOf(a);
  if (i >= 0) arr.splice(i, 1);
  if (!arr.length) delete store[n];
}

/* ---------- the selected mark and the bar that edits it ---------- */

/** Pick a mark (or none). The bar then shows THAT mark's colour, width and
 *  shape options, and changing them changes the mark (applyStyle). */
function setSelected(sel) {
  const prev = selected;
  selected = sel;
  setAnnotSel(sel ? sel.a.t : '');
  if (sel) {
    const a = sel.a;
    if (a.c) setAnnotColor(a.c);
    if (a.t === 'highlight') setAnnotWidth(r2(a.w / 5));
    else if (typeof a.w === 'number' && a.t !== 'mark') setAnnotWidth(a.w);
    if (a.t === 'line' || a.t === 'arrow') {
      setAnnotLineKind(a.kind || 'straight');
      if (a.t === 'arrow') setAnnotHeads(headsOf(a));
    }
    if ('dash' in a || ['line', 'arrow', 'rect', 'ellipse', 'pen'].includes(a.t)) setAnnotDash(!!a.dash);
    if (a.t === 'rect') setAnnotRound(!!a.round);
    if (a.t === 'tbox') setAnnotFont(a.s);
  }
  if (prev && (!sel || prev.n !== sel.n)) redraw(prev.n);
}

/** Change the selected mark: { c, w, kind, heads, dash, round, s }. Each key
 *  applies only where it means something. No selection: nothing happens (the
 *  bar's value is then just the next mark's). */
export function applyStyle(patch) {
  if (!selected) return false;
  const { n, a } = selected;
  // Worked out on a copy, so the undo snapshot is taken only when something
  // really changes — and holds the mark as it was.
  const next = JSON.parse(JSON.stringify(a));
  if (patch.c) next.c = patch.c;
  if (patch.w != null && typeof next.w === 'number' && next.t !== 'mark') next.w = next.t === 'highlight' ? patch.w * 5 : patch.w;
  if (patch.kind && (next.t === 'line' || next.t === 'arrow')) setLineKind(next, patch.kind);
  if (patch.heads && next.t === 'arrow') next.heads = patch.heads;
  if (patch.dash != null && ['line', 'arrow', 'rect', 'ellipse', 'pen'].includes(next.t)) {
    if (patch.dash) next.dash = true; else delete next.dash;
  }
  if (patch.round != null && next.t === 'rect') { if (patch.round) next.round = true; else delete next.round; }
  if (patch.s != null && next.t === 'tbox') next.s = patch.s;
  if (JSON.stringify(next) === JSON.stringify(a)) return false;
  snapshot();
  Object.keys(a).forEach((k) => delete a[k]);
  Object.assign(a, next);
  persist();
  redraw(n);
  return true;
}

/** Make a line straight, curved or elbowed, keeping its two ends. */
function setLineKind(a, kind) {
  delete a.mx; delete a.my; delete a.el;
  if (kind === 'curve') {
    // A gentle bend to start from: its middle a sixth of the length off the
    // chord. The middle handle shapes it from there.
    const dx = a.x1 - a.x0, dy = a.y1 - a.y0;
    a.kind = 'curve';
    a.mx = r2((a.x0 + a.x1) / 2 + dy * 0.18);
    a.my = r2((a.y0 + a.y1) / 2 - dx * 0.18);
  } else if (kind === 'elbow') {
    a.kind = 'elbow';
    a.el = Math.abs(a.x1 - a.x0) >= Math.abs(a.y1 - a.y0) ? 'h' : 'v';
  } else delete a.kind;
}

/* ---------- rendering ---------- */
function el(tag, attrs, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}

function renderAnnot(a) {
  const g = el('g', {});
  for (const p of markPaths(a)) {
    el('path', {
      d: p.d,
      fill: p.fill || 'none',
      'fill-opacity': p.fill && p.op !== 1 ? p.op : null,
      stroke: p.stroke || 'none',
      'stroke-width': p.stroke ? p.w : null,
      'stroke-opacity': p.stroke && p.op !== 1 ? p.op : null,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'stroke-dasharray': p.dash ? p.dash.join(' ') : null,
    }, g);
  }
  if (a.t === 'note') {
    g.setAttribute('class', 'annot-note');
    // The icon is a button: a click folds the comment down to it, another
    // brings the text back — also while just reading, with no tool in hand
    // (the layer itself lets the pointer through then; the icon does not).
    const icon = g.firstChild;
    if (icon) {
      icon.setAttribute('class', `annot-note-icon${a.closed ? ' closed' : ''}`);
      icon.addEventListener('click', (e) => {
        if (annotTool()) return; // with a tool active the layer's own handlers decide
        e.stopPropagation();
        toggleNote(a);
      });
      if (a.closed && a.str) el('title', {}, icon).textContent = a.str;
    }
    if (a.str && !a.closed) {
      const fo = el('foreignObject', { x: a.x + 10, y: a.y - 6, width: noteWidth(a) + 4, height: noteHeight(a) + 4 }, g);
      const box = document.createElement('div');
      box.className = 'annot-note-box';
      box.style.setProperty('--note', a.c);
      box.style.fontSize = NOTE_FONT + 'px';
      box.textContent = a.str;
      fo.appendChild(box);
    }
  } else if (a.t === 'tbox') {
    if (a !== editing) {
      const fo = el('foreignObject', { x: a.x, y: a.y, width: a.bw, height: tboxHeight(a) + a.s, overflow: 'visible' }, g);
      const box = document.createElement('div');
      box.className = 'annot-tbox';
      box.style.fontSize = a.s + 'px';
      box.style.color = a.c;
      box.textContent = a.str;
      fo.appendChild(box);
    }
  } else if (a.t === 'text') { // notes of earlier versions: plain text on the page
    const t = el('text', { x: a.x, y: a.y, fill: a.c, 'font-size': a.s, 'font-family': 'Segoe UI, system-ui, sans-serif' }, g);
    t.textContent = a.str;
  }
  return g;
}

/** Screen pixels per PDF point on this layer (1 when it is not laid out). */
function pxPerPt(svg, W) {
  const w = svg.getBoundingClientRect().width;
  return w > 0 && W > 0 ? w / W : 1;
}
const HANDLE_PX = 8;

function redraw(n, svg) {
  svg = svg || layers.get(n);
  if (!svg) return;
  const all = store[n] || [];
  const ink = inks.get(n);
  if (ink) ink.replaceChildren(...all.filter(isInk).map(renderAnnot));
  svg.replaceChildren(...all.filter((a) => !ink || !isInk(a)).map(renderAnnot));
  if (selected && selected.n === n && all.includes(selected.a)) {
    const a = selected.a;
    const k = pxPerPt(svg, sizeOf(n).w);
    const isLine = a.t === 'line' || a.t === 'arrow';
    if (!isLine) {
      const [x0, y0, x1, y1] = bbox(a);
      const m = 3 / k;
      el('rect', {
        x: x0 - m, y: y0 - m, width: x1 - x0 + 2 * m, height: y1 - y0 + 2 * m,
        class: 'annot-selection', 'vector-effect': 'non-scaling-stroke',
      }, svg);
    }
    // The handles keep their size on screen at every zoom.
    const s = HANDLE_PX / k;
    for (const h of handlesOf(a)) {
      el(h.id === 'mid' ? 'circle' : 'rect', h.id === 'mid'
        ? { cx: h.x, cy: h.y, r: s / 2, class: 'annot-handle annot-handle-mid', 'vector-effect': 'non-scaling-stroke' }
        : { x: h.x - s / 2, y: h.y - s / 2, width: s, height: s, class: `annot-handle annot-h-${h.id}`, 'vector-effect': 'non-scaling-stroke' },
      svg);
    }
  }
}
function redrawAll() { for (const n of layers.keys()) redraw(n); }
const sizeOf = (n) => sizes.get(n) || sizes.values().next().value || { w: 612, h: 792 };

/* ---------- comments folded to their icon ---------- */
function pageOf(a) {
  for (const n of Object.keys(store)) if (store[n].includes(a)) return +n;
  return null;
}
/** Fold a comment down to its icon, or show its text again. */
function toggleNote(a) {
  const n = pageOf(a);
  if (n == null || !a.str) return;
  snapshot();
  if (a.closed) delete a.closed; else a.closed = true;
  persist();
  redraw(n);
}
/** Every comment of the document at once: fold them all while any is open,
 *  otherwise open them all. Returns 'closed' | 'open' | null (no comments). */
export function toggleAllNotes() {
  const notes = Object.values(store).flat().filter((a) => a.t === 'note' && a.str);
  if (!notes.length) return null;
  const close = notes.some((a) => !a.closed);
  snapshot();
  for (const a of notes) { if (close) a.closed = true; else delete a.closed; }
  persist();
  redrawAll();
  return close ? 'closed' : 'open';
}

/* ---------- comments and text boxes, written in place ---------- */
function editText(n, a, content, isNew) {
  const { w, h } = sizeOf(n);
  const svg = layers.get(n);
  const ta = document.createElement('textarea');
  const isBox = a.t === 'tbox';
  // Writing in a folded comment unfolds it: its text is what is being edited.
  if (a.closed) { delete a.closed; redraw(n); }
  ta.className = isBox ? 'annot-tbox-editor' : 'annot-note-editor';
  ta.value = a.str || '';
  ta.placeholder = isBox ? 'Texto… (Ctrl+Intro termina, Esc cancela)' : 'Comentario… (Ctrl+Intro para terminar, Esc cancela)';
  if (isBox) {
    // The editor sits exactly where the text will be, at its real size.
    const k = svg ? pxPerPt(svg, w) : 1;
    ta.style.left = `${(a.x / w) * 100}%`;
    ta.style.top = `${(a.y / h) * 100}%`;
    ta.style.width = `${(a.bw / w) * 100}%`;
    ta.style.fontSize = `${a.s * k}px`;
    ta.style.color = a.c;
    ta.rows = Math.max(1, String(a.str || '').split('\n').length);
    editing = a;
    redraw(n);
  } else {
    ta.style.left = `${((a.x + 10) / w) * 100}%`;
    ta.style.top = `${((a.y - 6) / h) * 100}%`;
    ta.style.setProperty('--note', a.c);
  }
  content.appendChild(ta);
  const grow = () => { if (isBox) { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; } };
  ta.addEventListener('input', grow);
  let done = false;
  // keep = commit what was typed (an emptied one goes); otherwise cancel.
  // The snapshot taken before editing is dropped when nothing changed.
  const finish = (keep) => {
    if (done) return;
    done = true;
    const str = ta.value.replace(/\s+$/, '');
    ta.remove();
    editing = null;
    const changed = keep && str !== (a.str || '');
    if (keep && str) a.str = str;
    else if (isNew || keep) removeMark(n, a);
    if (!changed && !(keep && !str && !isNew)) undoStack.pop();
    if (selected && selected.a === a && !(store[n] || []).includes(a)) setSelected(null);
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
  requestAnimationFrame(() => { ta.focus(); grow(); });
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
  hl: 'Resaltado', ul: 'Subrayado', st: 'Tachado', note: 'Comentario', text: 'Nota', tbox: 'Texto', pen: 'Trazo',
  highlight: 'Rotulador', line: 'Línea', arrow: 'Flecha', rect: 'Recuadro', ellipse: 'Elipse',
};
/** Every mark of the document as one line of text, page by page. */
export function correctionsText() {
  const lines = [];
  for (const n of annotatedPages()) {
    for (const a of store[n]) {
      const what = LABEL[a.t === 'mark' ? a.k : a.t] || a.t;
      const body = a.t === 'mark' ? `: «${a.txt || ''}»` : a.str ? `: ${a.str.replace(/\s*\n\s*/g, ' / ')}` : '';
      lines.push(`Pág. ${n} · ${what}${body}`);
    }
  }
  return lines.join('\n');
}

/* ---------- keyboard: Supr, Esc, arrows, Ctrl+Z / Ctrl+Y while reviewing ---------- */
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => {
    if (!annotTool()) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const mod = e.ctrlKey || e.metaKey;
    const nudge = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'z') { undo(); }
    else if (mod && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { redo(); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
      snapshot();
      const n = selected.n;
      removeMark(n, selected.a);
      setSelected(null);
      persist();
      redraw(n);
    } else if (nudge && selected && !mod) {
      // The arrows move the selected mark a point at a time (Shift: ten).
      const step = e.shiftKey ? 10 : 1;
      snapshot();
      moveMark(selected.a, nudge[0] * step, nudge[1] * step);
      persist();
      redraw(selected.n);
    } else if (e.key === 'Escape' && selected) {
      const n = selected.n;
      setSelected(null);
      redraw(n);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  }, true);
}

/* ---------- the pointer: a circle the size of the tip ---------- */
let brush = null;
/** Diameter of the active tool's tip, in PDF points. */
function tipSize(tool) {
  if (tool === 'highlight') return annotWidth() * 5;
  if (tool === 'eraser') return Math.max(5, annotWidth() * 4);
  if (tool === 'laser') return 0; // fixed on screen, see showBrush
  return annotWidth();
}
function showBrush(e, k) {
  const tool = annotTool();
  if (!BRUSH_TOOLS.has(tool)) { hideBrush(); return; }
  if (!brush) {
    brush = document.createElement('div');
    brush.className = 'annot-brush';
    document.body.appendChild(brush);
  }
  // Never smaller than 4px: a 1pt pen at 60% zoom would be an invisible dot.
  const d = tool === 'laser' ? 10 : Math.max(4, tipSize(tool) * k);
  brush.classList.toggle('laser', tool === 'laser');
  brush.style.width = brush.style.height = `${d}px`;
  brush.style.transform = `translate(${e.clientX - d / 2}px, ${e.clientY - d / 2}px)`;
  brush.style.display = 'block';
}
function hideBrush() { if (brush) brush.style.display = 'none'; }

/* ---------- drawing ---------- */
function newAnnot(tool, x, y) {
  const c = annotColor(), w = annotWidth();
  if (tool === 'highlight') return { t: 'highlight', c, w: w * 5, pts: [x, y] };
  if (tool === 'pen') return annotDash() ? { t: 'pen', c, w, pts: [x, y], dash: true } : { t: 'pen', c, w, pts: [x, y] };
  const a = { t: tool, c, w, x0: x, y0: y, x1: x, y1: y };
  if (annotDash()) a.dash = true;
  if (tool === 'rect' && annotRound()) a.round = true;
  if (tool === 'arrow' && annotHeads() !== 'end') a.heads = annotHeads();
  return a;
}
function isEmpty(a) {
  if (a.pts) return a.pts.length < 4;
  return Math.abs(a.x1 - a.x0) < 2 && Math.abs(a.y1 - a.y0) < 2;
}
function topHit(n, x, y, tol) {
  const arr = store[n] || [];
  for (let i = arr.length - 1; i >= 0; i--) if (hitTest(arr[i], x, y, tol)) return arr[i];
  return null;
}

/** Build (and wire) a page's annotation overlay; `w`×`h` is the page's size
 *  in points. Called every time the page is (re)rendered. */
export function buildAnnotLayer(n, content, w, h) {
  if (w && h) sizes.set(n, { w, h });
  const { w: W, h: H } = sizeOf(n);
  const ink = el('svg', { class: 'pdf-annotlayer pdf-annotink', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none' });
  const svg = el('svg', { class: 'pdf-annotlayer', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none' });
  // The laser's strokes live apart: they are never stored, and redrawing the
  // marks must not wipe one that is still fading.
  const laser = el('svg', { class: 'pdf-annotlayer pdf-annotlaser', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none' });
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
  const scaleNow = () => pxPerPt(svg, W);
  let cur = null;      // the mark being drawn
  let drag = null;     // moving the selected mark, or one of its handles
  let erasing = null;  // { erased, x, y } during an eraser stroke
  let beam = null;     // { path, pts } while the laser is down
  let lastTap = null;  // { t, a }: a second press on the same note edits it
  const capture = (e) => { try { svg.setPointerCapture(e.pointerId); } catch (_) { /* gone */ } };

  const erase = (x, y) => {
    const r = tipSize('eraser') / 2;
    // Every step of the way from the last sample: a fast sweep must not jump
    // over a thin stroke.
    const from = erasing.x == null ? [x, y] : [erasing.x, erasing.y];
    const steps = Math.max(1, Math.ceil(Math.hypot(x - from[0], y - from[1]) / Math.max(0.5, r / 2)));
    for (let i = 1; i <= steps; i++) {
      const px = from[0] + (x - from[0]) * (i / steps), py = from[1] + (y - from[1]) * (i / steps);
      const next = eraseAt(store[n] || [], px, py, r, annotEraser() !== 'part');
      if (!next) continue;
      if (next.length) store[n] = next; else delete store[n];
      erasing.erased = true;
    }
    erasing.x = x; erasing.y = y;
    if (selected && selected.n === n && !(store[n] || []).includes(selected.a)) setSelected(null);
    redraw(n, svg);
  };

  svg.addEventListener('pointerdown', (e) => {
    const tool = annotTool();
    if (!tool || TEXT_TOOLS.has(tool) || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const [x, y] = toPt(e);
    const k = scaleNow();
    if (tool === 'laser') {
      const path = el('path', { class: 'annot-laser', 'stroke-width': 3.2 / k, d: `M${r2(x)} ${r2(y)} h0.01` }, laser);
      beam = { path, pts: [x, y] };
      capture(e);
      return;
    }
    if (tool === 'eraser') {
      snapshot();
      erasing = { erased: false, x: null, y: null };
      erase(x, y);
      capture(e);
      return;
    }
    if (tool === 'select') {
      // A handle of the selected mark first: it sits on top of everything.
      if (selected && selected.n === n) {
        const reach = (HANDLE_PX / 2 + 3) / k;
        const h = handlesOf(selected.a).find((hd) => Math.hypot(hd.x - x, hd.y - y) <= reach);
        if (h) {
          snapshot();
          drag = { handle: h.id, orig: JSON.parse(JSON.stringify(selected.a)), moved: false };
          capture(e);
          return;
        }
      }
      const a = topHit(n, x, y, 4 / k);
      setSelected(a ? { n, a } : null);
      redraw(n, svg);
      const again = a && lastTap && lastTap.a === a && e.timeStamp - lastTap.t < 450;
      lastTap = a ? { t: e.timeStamp, a } : null;
      if (a) {
        if (again && (a.t === 'note' || a.t === 'tbox')) { snapshot(); editText(n, a, content, false); return; }
        snapshot();
        drag = { x, y, moved: false, icon: onNoteIcon(a, x, y) ? a : null };
        capture(e);
      }
      return;
    }
    if (tool === 'note' || tool === 'tbox') {
      const a = topHit(n, x, y, 3 / k);
      if (a && a.t === tool) { snapshot(); editText(n, a, content, false); return; }
      snapshot();
      const mark = tool === 'note'
        ? { t: 'note', c: annotColor(), x, y, str: '' }
        // As wide as fits from the click to the right edge, up to 220 pt.
        : { t: 'tbox', c: annotColor(), x, y, bw: r2(Math.max(40, Math.min(220, W - x - 6))), s: annotFont(), str: '' };
      (store[n] || (store[n] = [])).push(mark);
      redraw(n, svg);
      editText(n, mark, content, true);
      return;
    }
    snapshot();
    cur = newAnnot(tool, r2(x), r2(y));
    (store[n] || (store[n] = [])).push(cur);
    capture(e);
    redraw(n, svg);
  });

  svg.addEventListener('pointermove', (e) => {
    showBrush(e, scaleNow());
    if (!cur && !drag && !erasing && !beam) return;
    e.preventDefault();
    e.stopPropagation();
    const [x, y] = toPt(e);
    if (beam) {
      beam.pts.push(r2(x), r2(y));
      let d = `M${beam.pts[0]} ${beam.pts[1]}`;
      for (let i = 2; i + 1 < beam.pts.length; i += 2) d += ` L${beam.pts[i]} ${beam.pts[i + 1]}`;
      beam.path.setAttribute('d', d);
      return;
    }
    if (erasing) { erase(x, y); return; }
    if (drag) {
      if (!selected) { drag = null; return; }
      if (drag.handle) applyHandle(selected.a, drag.handle, x, y, drag.orig, e.shiftKey);
      else { moveMark(selected.a, x - drag.x, y - drag.y); drag.x = x; drag.y = y; }
      drag.moved = true;
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
      const isLine = cur.t === 'line' || cur.t === 'arrow';
      if (e.shiftKey) {
        if (isLine) [ex, ey] = snapAngle(cur.x0, cur.y0, x, y);
        else {
          const dx = x - cur.x0, dy = y - cur.y0, s = Math.max(Math.abs(dx), Math.abs(dy));
          ex = cur.x0 + Math.sign(dx || 1) * s; ey = cur.y0 + Math.sign(dy || 1) * s;
        }
      }
      cur.x1 = r2(ex);
      cur.y1 = r2(ey);
      // The chosen variant follows the pointer while the line is drawn.
      if (isLine && annotLineKind() !== 'straight') setLineKind(cur, annotLineKind());
    }
    redraw(n, svg);
  });

  const end = (e) => {
    if (beam) {
      // It stays long enough to be pointed at, then fades by itself.
      const path = beam.path;
      beam = null;
      setTimeout(() => path.classList.add('out'), 1700);
      setTimeout(() => path.remove(), 2600);
    } else if (erasing) {
      if (!erasing.erased) undoStack.pop();
      erasing = null;
      persist();
    } else if (drag) {
      const icon = !drag.moved && drag.icon;
      if (!drag.moved) undoStack.pop();
      drag = null;
      persist();
      // A plain click on a comment's icon folds / unfolds it.
      if (icon) toggleNote(icon);
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
  svg.addEventListener('pointerleave', hideBrush);

  content.append(ink, svg, laser);
  return svg;
}
