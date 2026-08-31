// PDF annotation layer: freehand pen, highlighter, shapes, arrows and text
// notes drawn ON the page — like the markup tools of a desktop PDF viewer.
//
// Coordinates are stored in PDF POINT space (the same baseW×baseH the page has
// at scale 1), so every annotation scales perfectly with zoom and survives the
// page re-rasterizing. Each page draws its own <svg> overlay (rebuilt on every
// render); the data lives in `store`, persisted per PDF path in localStorage.

import { annotTool, annotColor, annotWidth } from '../solid/stores/previewStore.js';

const SVGNS = 'http://www.w3.org/2000/svg';

let store = {};            // pageNumber -> [annotation]
let docKey = null;         // localStorage key for the current PDF
let dims = { w: 612, h: 792 }; // page size in points (set per document)
const layers = new Map();  // pageNumber -> live <svg> element

/** Point a new PDF at the layer: load its saved annotations (or start empty). */
export function setAnnotDoc(path, baseW, baseH) {
  if (baseW) dims = { w: baseW, h: baseH };
  docKey = path ? 'pyx-annot:' + path : null;
  store = {};
  if (docKey) {
    try { store = JSON.parse(localStorage.getItem(docKey) || '{}') || {}; } catch (_) { store = {}; }
  }
  layers.clear();
}

function persist() {
  if (!docKey) return;
  try {
    if (Object.keys(store).length) localStorage.setItem(docKey, JSON.stringify(store));
    else localStorage.removeItem(docKey);
  } catch (_) { /* quota / private mode */ }
}

export function hasAnnots() { return Object.values(store).some((a) => a && a.length); }
export function clearPage(n) { delete store[n]; persist(); redraw(n); }
export function clearAllAnnots() {
  const pages = Object.keys(store);
  store = {};
  persist();
  for (const n of pages) redraw(+n);
}
export function undoLast() {
  // Remove the most recently drawn annotation across the document.
  let last = null;
  for (const n of Object.keys(store)) {
    const arr = store[n];
    if (arr && arr.length) { last = +n; }
  }
  if (last != null) { store[last].pop(); if (!store[last].length) delete store[last]; persist(); redraw(last); }
}

/* ---------- rendering ---------- */
function ptsToStr(pts) {
  let s = '';
  for (let i = 0; i < pts.length; i += 2) s += `${pts[i]},${pts[i + 1]} `;
  return s.trim();
}
function renderAnnot(a) {
  if (a.t === 'pen' || a.t === 'highlight') {
    const el = document.createElementNS(SVGNS, 'polyline');
    el.setAttribute('points', ptsToStr(a.pts));
    el.setAttribute('fill', 'none');
    el.setAttribute('stroke', a.c);
    el.setAttribute('stroke-width', a.w);
    el.setAttribute('stroke-linejoin', 'round');
    if (a.t === 'highlight') { el.setAttribute('stroke-opacity', '0.35'); el.setAttribute('stroke-linecap', 'butt'); }
    else el.setAttribute('stroke-linecap', 'round');
    return el;
  }
  if (a.t === 'rect') {
    const el = document.createElementNS(SVGNS, 'rect');
    el.setAttribute('x', Math.min(a.x0, a.x1));
    el.setAttribute('y', Math.min(a.y0, a.y1));
    el.setAttribute('width', Math.abs(a.x1 - a.x0));
    el.setAttribute('height', Math.abs(a.y1 - a.y0));
    el.setAttribute('fill', 'none');
    el.setAttribute('stroke', a.c);
    el.setAttribute('stroke-width', a.w);
    return el;
  }
  if (a.t === 'line' || a.t === 'arrow') {
    const g = document.createElementNS(SVGNS, 'g');
    g.setAttribute('stroke', a.c);
    g.setAttribute('stroke-width', a.w);
    g.setAttribute('stroke-linecap', 'round');
    g.setAttribute('stroke-linejoin', 'round');
    g.setAttribute('fill', 'none');
    const ln = document.createElementNS(SVGNS, 'line');
    ln.setAttribute('x1', a.x0); ln.setAttribute('y1', a.y0);
    ln.setAttribute('x2', a.x1); ln.setAttribute('y2', a.y1);
    g.appendChild(ln);
    if (a.t === 'arrow') {
      const ang = Math.atan2(a.y1 - a.y0, a.x1 - a.x0);
      const len = Math.max(8, a.w * 4);
      for (const d of [Math.PI - 0.4, Math.PI + 0.4]) {
        const h = document.createElementNS(SVGNS, 'line');
        h.setAttribute('x1', a.x1); h.setAttribute('y1', a.y1);
        h.setAttribute('x2', a.x1 + len * Math.cos(ang + d));
        h.setAttribute('y2', a.y1 + len * Math.sin(ang + d));
        g.appendChild(h);
      }
    }
    return g;
  }
  if (a.t === 'text') {
    const el = document.createElementNS(SVGNS, 'text');
    el.setAttribute('x', a.x); el.setAttribute('y', a.y);
    el.setAttribute('fill', a.c);
    el.setAttribute('font-size', a.s);
    el.setAttribute('font-family', 'Segoe UI, system-ui, sans-serif');
    el.textContent = a.str;
    return el;
  }
  return document.createElementNS(SVGNS, 'g');
}
function redraw(n, svg) {
  svg = svg || layers.get(n);
  if (!svg) return;
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  for (const a of store[n] || []) svg.appendChild(renderAnnot(a));
}

/* ---------- hit testing (eraser) ---------- */
function distToSeg(px, py, x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - x0) * dx + (py - y0) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
}
function hitTest(a, x, y, tol) {
  if (a.t === 'pen' || a.t === 'highlight') {
    for (let i = 0; i + 3 < a.pts.length; i += 2) {
      if (distToSeg(x, y, a.pts[i], a.pts[i + 1], a.pts[i + 2], a.pts[i + 3]) <= tol + a.w / 2) return true;
    }
    return a.pts.length >= 2 && Math.hypot(x - a.pts[0], y - a.pts[1]) <= tol + a.w / 2;
  }
  if (a.t === 'line' || a.t === 'arrow') return distToSeg(x, y, a.x0, a.y0, a.x1, a.y1) <= tol + a.w / 2;
  if (a.t === 'rect') {
    const lx = Math.min(a.x0, a.x1), rx = Math.max(a.x0, a.x1);
    const ty = Math.min(a.y0, a.y1), by = Math.max(a.y0, a.y1);
    const nearV = (x >= lx - tol && x <= rx + tol);
    const nearH = (y >= ty - tol && y <= by + tol);
    return (nearH && (Math.abs(x - lx) <= tol || Math.abs(x - rx) <= tol))
        || (nearV && (Math.abs(y - ty) <= tol || Math.abs(y - by) <= tol));
  }
  if (a.t === 'text') return x >= a.x - tol && x <= a.x + a.str.length * a.s * 0.6 + tol && y >= a.y - a.s && y <= a.y + tol;
  return false;
}
function eraseAt(n, x, y) {
  const arr = store[n];
  if (!arr) return;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (hitTest(arr[i], x, y, 6)) { arr.splice(i, 1); if (!arr.length) delete store[n]; persist(); redraw(n); return; }
  }
}

/* ---------- drawing ---------- */
function newAnnot(tool, x, y, color, w) {
  if (tool === 'pen') return { t: 'pen', c: color, w, pts: [x, y] };
  if (tool === 'highlight') return { t: 'highlight', c: color, w: w * 5, pts: [x, y] };
  if (tool === 'rect') return { t: 'rect', c: color, w, x0: x, y0: y, x1: x, y1: y };
  if (tool === 'arrow') return { t: 'arrow', c: color, w, x0: x, y0: y, x1: x, y1: y };
  if (tool === 'line') return { t: 'line', c: color, w, x0: x, y0: y, x1: x, y1: y };
  return { t: 'pen', c: color, w, pts: [x, y] };
}
function isEmpty(a) {
  if (a.t === 'pen' || a.t === 'highlight') return a.pts.length < 4;
  return Math.abs(a.x1 - a.x0) < 2 && Math.abs(a.y1 - a.y0) < 2;
}

// Build (and attach handlers to) a page's annotation overlay. Called by the
// renderer every time the page content is (re)built.
export function buildAnnotLayer(n, content) {
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('class', 'pdf-annotlayer');
  svg.setAttribute('viewBox', `0 0 ${dims.w} ${dims.h}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  layers.set(n, svg);
  redraw(n, svg);

  const toPt = (e) => {
    const r = svg.getBoundingClientRect();
    return [
      Math.max(0, Math.min(dims.w, (e.clientX - r.left) / r.width * dims.w)),
      Math.max(0, Math.min(dims.h, (e.clientY - r.top) / r.height * dims.h)),
    ];
  };
  let cur = null;
  svg.addEventListener('pointerdown', (e) => {
    const tool = annotTool();
    if (!tool || e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const [x, y] = toPt(e);
    if (tool === 'eraser') { eraseAt(n, x, y); return; }
    if (tool === 'text') {
      const str = window.prompt('Texto de la nota:');
      if (str) {
        (store[n] || (store[n] = [])).push({ t: 'text', c: annotColor(), x, y: y + 12, s: Math.max(10, annotWidth() * 6), str });
        persist(); redraw(n);
      }
      return;
    }
    cur = newAnnot(tool, x, y, annotColor(), annotWidth());
    (store[n] || (store[n] = [])).push(cur);
    try { svg.setPointerCapture(e.pointerId); } catch (_) {}
    redraw(n, svg);
  });
  svg.addEventListener('pointermove', (e) => {
    if (!cur) return;
    e.preventDefault(); e.stopPropagation();
    const [x, y] = toPt(e);
    if (cur.t === 'pen' || cur.t === 'highlight') cur.pts.push(x, y);
    else { cur.x1 = x; cur.y1 = y; }
    redraw(n, svg);
  });
  const end = (e) => {
    if (!cur) return;
    if (isEmpty(cur) && store[n]) store[n] = store[n].filter((a) => a !== cur);
    cur = null;
    persist();
    try { svg.releasePointerCapture(e.pointerId); } catch (_) {}
    redraw(n, svg);
  };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);

  content.appendChild(svg);
  return svg;
}
