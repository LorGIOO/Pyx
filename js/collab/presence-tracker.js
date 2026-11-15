// What this window tells the others: which file is in front, where the caret
// and selection are, where the mouse is, where the view is scrolled to.
//
// The mouse is described by WHAT IS UNDER IT, never by screen pixels: the
// character under it in the editor (a Yjs relative position plus a fraction
// of a character/line), or the page and PDF point in the viewer. Everyone's
// window has another size, zoom, font, split and scroll — screen pixels would
// put the pointer somewhere else on each of them.
//
// Cost: one listener for pointer moves (passive), coalesced to one
// computation per animation frame; the session then sends at most ~30
// updates per second, and nothing at all while nothing changes.

import { createRoot, createEffect } from 'solid-js';
import { forEachEditorView, getView } from '../editor/setup.js';
import { docIdOf } from '../editor/doc-id.js';
import { EditorView } from '@codemirror/view';
import { boundPath, relFromIndex, indexFromRel, docIdOfPath } from './ybridge.js';
import { collabHooks } from './hooks.js';
import { state, activeDoc } from '../core/state.js';
import { pdfPointFromClient, pdfContainer, visiblePage, goToPage } from '../pdf/preview.js';
import { onPresenceChange, person } from './presence-store.js';
import { collab } from '../solid/stores/collabStore.js';

let cfg = null;
let cur = { f: null, s: null, p: null, t: null, pg: null };
let sentKey = '';
let lastXY = null;
let lastTarget = null;
let frame = 0;
let dispose = null;
let offFollow = null;
const listeners = [];

function on(target, type, fn, opts) {
  target.addEventListener(type, fn, opts);
  listeners.push(() => target.removeEventListener(type, fn, opts));
}

function viewAt(el) {
  let found = null;
  forEachEditorView((v) => { if (!found && v.dom.contains(el)) found = v; });
  return found;
}

const AREAS = [
  ['.ribbon-container, .ribbon', 'ribbon'],
  ['.doc-tabs, .document-tabs, .tabs-bar', 'tabs'],
  ['.side-panel, .sidepanel', 'side'],
  ['.status-bar', 'status'],
  ['.terminal-panel', 'terminal'],
  ['.cfg-modal, .collab-modal', 'dialog'],
];

function pointerAt(x, y, el) {
  if (!el || !el.closest) return null;
  if (el.closest('.cm-editor')) {
    const view = viewAt(el);
    if (view) {
      const docId = docIdOf(view.state);
      const path = boundPath(docId);
      if (!path) return { z: 'ui', a: 'other' };
      const pos = view.posAtCoords({ x, y }, false);
      if (pos == null) return { z: 'ui', a: 'other' };
      const c = view.coordsAtPos(pos) || view.coordsAtPos(pos, -1);
      const r = relFromIndex(docId, pos);
      if (!c || !r) return { z: 'ui', a: 'other' };
      return {
        z: 'ed', f: path, r,
        dx: +((x - c.left) / (view.defaultCharacterWidth || 8)).toFixed(2),
        dy: +((y - c.top) / (view.defaultLineHeight || 16)).toFixed(2),
      };
    }
  }
  const pc = pdfContainer();
  if (pc && pc.contains(el)) {
    const pt = pdfPointFromClient(x, y);
    if (pt) return { z: 'pdf', pg: pt.pg, x: Math.round(pt.x * 10) / 10, y: Math.round(pt.y * 10) / 10 };
    return { z: 'ui', a: 'other' };
  }
  for (const [sel, a] of AREAS) if (el.closest(sel)) return { z: 'ui', a };
  return { z: 'ui', a: 'other' };
}

function selectionOf(view) {
  const docId = docIdOf(view.state);
  const path = boundPath(docId);
  if (!path) return { f: null, s: null, t: null };
  const sel = view.state.selection.main;
  const a = relFromIndex(docId, sel.anchor);
  const h = relFromIndex(docId, sel.head);
  let t = null;
  try {
    const top = view.lineBlockAtHeight(Math.max(0, view.scrollDOM.scrollTop - (view.documentPadding ? view.documentPadding.top : 0)));
    t = relFromIndex(docId, top.from);
  } catch (_) { t = null; }
  return { f: path, s: a && h ? [a, h] : null, t };
}

function schedule() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    if (!cfg) return;
    if (lastXY) cur.p = pointerAt(lastXY[0], lastXY[1], lastTarget);
    const v = getView();
    const ad = activeDoc();
    if (v && ad && !ad.kind && docIdOf(v.state) === ad.id) Object.assign(cur, selectionOf(v));
    else Object.assign(cur, { f: null, s: null, t: null });
    cur.pg = pdfContainer() ? visiblePage() : null;
    const key = JSON.stringify(cur);
    if (key === sentKey) return;
    sentKey = key;
    cfg.publish({ ...cur });
  });
}

/* ---------- «Seguir a» ---------- */

let followSeen = { f: null, t: null, pg: null };

function applyFollow() {
  const mid = collab.follow;
  if (!mid) return;
  const p = person(mid);
  const s = p && p.state;
  if (!s) return;
  if (s.f && s.f !== followSeen.f) {
    followSeen.f = s.f;
    const id = docIdOfPath(s.f);
    const ad = activeDoc();
    if (!ad || ad.id !== id) import('./app.js').then((m) => m.openSharedFile(s.f)).catch(() => {});
  }
  if (s.t && s.t !== followSeen.t && s.f) {
    const id = docIdOfPath(s.f);
    forEachEditorView((v) => {
      if (docIdOf(v.state) !== id) return;
      const idx = indexFromRel(id, s.t);
      if (idx == null) return;
      followSeen.t = s.t;
      v.dispatch({ effects: EditorView.scrollIntoView(idx, { y: 'start' }) });
    });
  }
  if (s.pg && s.pg !== followSeen.pg) {
    followSeen.pg = s.pg;
    try { goToPage(s.pg); } catch (_) { /* no PDF yet */ }
  }
}

export function followPerson(mid) {
  collab.follow = mid || null;
  followSeen = { f: null, t: null, pg: null };
  applyFollow();
}

/* ---------- lifecycle ---------- */

export function startPresence(c) {
  stopPresence();
  cfg = c;
  sentKey = '';
  cur = { f: null, s: null, p: null, t: null, pg: null };
  on(window, 'pointermove', (e) => { lastXY = [e.clientX, e.clientY]; lastTarget = e.target; schedule(); }, { passive: true, capture: true });
  // Scrolling under a still mouse moves the text under it.
  on(document, 'scroll', () => schedule(), { passive: true, capture: true });
  // Any input of mine stops «Seguir a».
  const stopFollow = (e) => { if (e.isTrusted && collab.follow) followPerson(null); };
  on(window, 'wheel', stopFollow, { passive: true, capture: true });
  on(window, 'keydown', stopFollow, { capture: true });
  on(window, 'pointerdown', stopFollow, { capture: true });
  collabHooks.selection = () => schedule();
  dispose = createRoot((d) => {
    createEffect(() => {
      void state.activeIndex; // another tab in front
      const ad = activeDoc();
      if (cfg && ad) cfg.ensureShared(ad);
      schedule();
    });
    return d;
  });
  offFollow = onPresenceChange(() => applyFollow());
  schedule();
}

export function stopPresence() {
  for (const off of listeners.splice(0)) off();
  if (dispose) { dispose(); dispose = null; }
  if (offFollow) { offFollow(); offFollow = null; }
  cancelAnimationFrame(frame);
  frame = 0;
  collabHooks.selection = null;
  cfg = null;
  lastXY = null;
}
