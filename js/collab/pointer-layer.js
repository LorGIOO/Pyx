// The other people's mouse pointers, drawn over the editor and the PDF in
// real time — the arrow in their color with their name, like the pointer an
// assistant moves around a shared screen.
//
// Smooth without being late: the network brings ~30 positions per second; in
// between, each pointer glides toward its latest position with exponential
// smoothing (a ~45 ms time constant), every animation frame. The glide
// happens in DOCUMENT coordinates (the text, or the PDF page), so when you
// scroll your own window the pointers stay glued to the text instead of
// lagging behind.
//
// Cheap: one fixed layer over the window, one element per person, moved with
// transform (compositor only — no layout), and nothing inside CodeMirror's
// DOM (which it watches for changes). The loop stops when nothing moves.
//
// Out of view? A pill at the edge of the editor or the viewer, with the
// person's name and an arrow toward them; click it to go there.

import { EditorView } from '@codemirror/view';
import { forEachEditorView, getView } from '../editor/setup.js';
import { docIdOf } from '../editor/doc-id.js';
import { boundPath, indexFromRel } from './ybridge.js';
import { others, onPresenceChange } from './presence-store.js';
import { clientFromPdfPoint, goToPage } from '../pdf/preview.js';

const TAU = 45; // ms

let layer = null;
let raf = 0;
let last = 0;
let off = null;
let tick = 0;
const items = new Map(); // mid → { el, name, key, sx, sy, shown }

const ARROW = (color) => `<svg width="18" height="22" viewBox="0 0 18 22" aria-hidden="true">
  <path d="M1.5 1.5 L1.5 17.5 L5.6 13.6 L8.6 20.3 L11.4 19.1 L8.5 12.5 L14.3 12.4 Z"
    fill="${color}" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>`;

function makeItem(p) {
  const el = document.createElement('div');
  el.className = 'pyx-ptr';
  const arrow = document.createElement('div');
  arrow.className = 'pyx-ptr-arrow';
  const tag = document.createElement('div');
  tag.className = 'pyx-ptr-tag';
  el.append(arrow, tag);
  el.addEventListener('click', () => { const it = items.get(p.mid); if (it && it.go) it.go(); });
  layer.appendChild(el);
  return { el, arrow, tag, color: null, name: null, key: null, sx: 0, sy: 0, shown: false, go: null };
}

function paintIdentity(it, p) {
  if (it.color !== p.color) {
    it.color = p.color;
    it.arrow.innerHTML = ARROW(/^#[0-9a-f]{3,8}$/i.test(p.color) ? p.color : '#888'); // color validated: no markup from outside
    it.tag.style.background = it.color;
  }
  if (it.name !== p.name) { it.name = p.name; it.tag.textContent = p.name; }
}

/** The editor view that should show a pointer in file `path`: the focused
 *  pane if it shows that file, else any pane that does. */
function viewFor(path) {
  const active = getView();
  if (active && boundPath(docIdOf(active.state)) === path) return active;
  let found = null;
  forEachEditorView((v) => { if (!found && boundPath(docIdOf(v.state)) === path) found = v; });
  return found;
}

/** Where a person's pointer should be: a resolver from smoothed document
 *  coordinates to the screen, plus the target in those coordinates. */
function targetOf(p) {
  const s = p.state && p.state.p;
  if (!s) return null;
  if (s.z === 'ed') {
    const view = viewFor(s.f);
    if (!view) return null;
    const docId = docIdOf(view.state);
    const idx = indexFromRel(docId, s.r);
    if (idx == null || idx > view.state.doc.length) return null;
    const cw = view.defaultCharacterWidth || 8, lh = view.defaultLineHeight || 16;
    const box = view.scrollDOM.getBoundingClientRect();
    const left = box.left - view.scrollDOM.scrollLeft;
    const c = view.coordsAtPos(idx) || view.coordsAtPos(idx, -1);
    let tx, ty;
    if (c) {
      tx = c.left - left + s.dx * cw;
      ty = c.top - view.documentTop + s.dy * lh;
    } else {
      // Not rendered (far from the viewport): the line's height is known.
      const b = view.lineBlockAt(idx);
      const content = view.contentDOM.getBoundingClientRect();
      tx = content.left - left + s.dx * cw; // the column does not matter: it is off screen
      ty = b.top + s.dy * lh;
    }
    return {
      key: `ed:${s.f}:${docId}`,
      tx, ty,
      toScreen: (x, y) => ({ x: left + x, y: view.documentTop + y }),
      box,
      go: () => view.dispatch({ effects: EditorView.scrollIntoView(idx, { y: 'center' }) }),
    };
  }
  if (s.z === 'pdf') {
    const r = clientFromPdfPoint(s.pg, s.x, s.y);
    if (!r) return null;
    const go = () => goToPage(s.pg);
    if (r.off) return { key: `pdf:${s.pg}`, off: r.off, box: r.box, go };
    return {
      key: `pdf:${s.pg}`,
      tx: s.x, ty: s.y,
      toScreen: (x, y) => {
        const q = clientFromPdfPoint(s.pg, x, y);
        return q && !q.off ? { x: q.x, y: q.y } : { x: r.x, y: r.y };
      },
      box: r.box,
      go,
    };
  }
  return null;
}

function frame(t) {
  raf = 0;
  if (!layer) return;
  const dt = last ? Math.min(100, t - last) : 16;
  last = t;
  const k = 1 - Math.exp(-dt / TAU);
  let moving = false;
  const seen = new Set();
  for (const p of others()) {
    seen.add(p.mid);
    let it = items.get(p.mid);
    const tg = targetOf(p);
    if (!tg) { if (it && it.shown) { it.el.classList.remove('on'); it.shown = false; } continue; }
    if (!it) { it = makeItem(p); items.set(p.mid, it); }
    paintIdentity(it, p);
    it.go = tg.go;
    const b = tg.box;
    let x, y, edge = '';
    if (tg.off) {
      edge = tg.off;
      x = b.left + b.width / 2;
      y = tg.off === 'up' ? b.top + 6 : b.bottom - 30;
      it.key = null;
    } else {
      if (it.key !== tg.key) { it.key = tg.key; it.sx = tg.tx; it.sy = tg.ty; }
      else {
        it.sx += (tg.tx - it.sx) * k;
        it.sy += (tg.ty - it.sy) * k;
        if (Math.abs(tg.tx - it.sx) > 0.3 || Math.abs(tg.ty - it.sy) > 0.3) moving = true;
      }
      const q = tg.toScreen(it.sx, it.sy);
      x = q.x; y = q.y;
      // Outside the visible part of its pane: a pill at the nearest edge.
      if (y < b.top) { edge = 'up'; y = b.top + 6; }
      else if (y > b.bottom - 4) { edge = 'down'; y = b.bottom - 30; }
      if (x < b.left) { x = b.left + 4; if (!edge) edge = 'left'; }
      else if (x > b.right - 4) { x = b.right - 90; if (!edge) edge = 'right'; }
    }
    it.el.classList.toggle('edge', !!edge);
    it.el.dataset.dir = edge;
    it.el.style.transform = `translate3d(${Math.round(x * 2) / 2}px, ${Math.round(y * 2) / 2}px, 0)`;
    if (!it.shown) { it.el.classList.add('on'); it.shown = true; }
  }
  for (const [mid, it] of items) if (!seen.has(mid)) { it.el.remove(); items.delete(mid); }
  if (moving) kick();
}

function kick() {
  if (!raf && layer) raf = requestAnimationFrame(frame);
}

export function startPointers() {
  stopPointers();
  layer = document.createElement('div');
  layer.className = 'pyx-ptr-layer';
  document.body.appendChild(layer);
  off = onPresenceChange(kick);
  // Text the others insert above a still pointer moves it: a slow refresh
  // keeps it on its character between their updates.
  tick = setInterval(kick, 250);
  // My own scrolling and resizing move where their pointers land.
  window.addEventListener('scroll', kick, { passive: true, capture: true });
  window.addEventListener('resize', kick, { passive: true });
  kick();
}

export function stopPointers() {
  if (off) { off(); off = null; }
  clearInterval(tick);
  window.removeEventListener('scroll', kick, { capture: true });
  window.removeEventListener('resize', kick);
  cancelAnimationFrame(raf);
  raf = 0;
  last = 0;
  items.clear();
  if (layer) { layer.remove(); layer = null; }
}
