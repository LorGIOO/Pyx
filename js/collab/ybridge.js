// CodeMirror ⇄ Yjs, for the documents of a shared session.
//
// Pyx keeps each document in a CodeMirror state that lives in a pane when it
// is on screen and in a store when it is in a background tab — so the binding
// cannot be a view plugin (y-codemirror's approach): a background tab must
// keep receiving the others' edits. Instead it hooks the two places every
// edit already goes through (editor/setup.js):
//
//   local edit  → its ChangeSet is replayed onto the Y.Text (one Yjs
//                 transaction, origin LOCAL), and the session sends it out;
//   remote edit → the Y.Text's delta becomes a ChangeSet applied with
//                 applyRemoteChanges: undo history untouched, permission
//                 filter bypassed, never echoed back.
//
// INVARIANT: the Y.Text and the editor text are identical after every step.
// Both use UTF-16 offsets, so positions translate one to one. If they ever
// disagreed (a bug), the editor is reset to the Y.Text, which is the copy
// everybody shares.

import * as Y from 'yjs';
import { applyRemoteChanges, getDocText } from '../editor/setup.js';
import { collabHooks } from './hooks.js';
import { b64u, fromB64u } from './bytes.js';

export const LOCAL = Symbol('pyx-local');
const bound = new Map(); // docId → { ydoc, ytext, observer, path }

/** Yjs delta → CodeMirror change specs, in the coordinates of the old text. */
export function deltaToChanges(delta) {
  const out = [];
  let pos = 0;
  for (const op of delta) {
    if (op.retain != null) pos += op.retain;
    else if (op.insert != null) out.push({ from: pos, insert: typeof op.insert === 'string' ? op.insert : '' });
    else if (op.delete != null) { out.push({ from: pos, to: pos + op.delete }); pos += op.delete; }
  }
  return out;
}

/** Replay a CodeMirror ChangeSet onto a Y.Text (same coordinates). */
export function applyChangesToYText(ytext, changes) {
  let adj = 0;
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const at = fromA + adj;
    const del = toA - fromA;
    if (del > 0) ytext.delete(at, del);
    const s = inserted.toString();
    if (s) ytext.insert(at, s);
    adj += s.length - del;
  });
}

function localChange(docId, changes) {
  const b = bound.get(docId);
  if (!b) return;
  b.ydoc.transact(() => applyChangesToYText(b.ytext, changes), LOCAL);
  // Cheap guard of the invariant (lengths): a mismatch means a bug, and the
  // shared copy wins.
  const t = getDocText(docId);
  if (t && t.length !== b.ytext.length) {
    console.warn('[Pyx] el documento compartido se había desincronizado; se restablece');
    resetToY(docId);
  }
}

function resetToY(docId) {
  const b = bound.get(docId);
  const t = getDocText(docId);
  if (!b || !t) return;
  const y = b.ytext.toString();
  if (t.toString() !== y) applyRemoteChanges(docId, [{ from: 0, to: t.length, insert: y }]);
}

/**
 * Tie a document to its shared Y.Doc.
 *   from 'cm' — the editor holds the text (host): an empty Y.Text is filled
 *               from it; a Y.Text that already has text wins.
 *   from 'y'  — the Y.Text holds the text (guest, or a host file reopened).
 */
export function bindDoc(docId, ydoc, path, { from = 'y' } = {}) {
  unbindDoc(docId);
  const ytext = ydoc.getText('t');
  const t = getDocText(docId);
  const cur = t ? t.toString() : '';
  if (from === 'cm' && ytext.length === 0) {
    if (cur) ydoc.transact(() => ytext.insert(0, cur), LOCAL);
  } else if (ytext.toString() !== cur) {
    applyRemoteChanges(docId, [{ from: 0, to: cur.length, insert: ytext.toString() }]);
  }
  const observer = (ev, tr) => {
    if (tr.origin === LOCAL) return;
    const changes = deltaToChanges(ev.delta);
    if (changes.length && !applyRemoteChanges(docId, changes)) unbindDoc(docId);
  };
  ytext.observe(observer);
  bound.set(docId, { ydoc, ytext, observer, path });
  collabHooks.local = localChange;
}

export function unbindDoc(docId) {
  const b = bound.get(docId);
  if (!b) return;
  b.ytext.unobserve(b.observer);
  bound.delete(docId);
  if (!bound.size) collabHooks.local = null;
}

export function unbindAll() {
  for (const id of [...bound.keys()]) unbindDoc(id);
}

export const isBound = (docId) => bound.has(docId);
export const boundPath = (docId) => (bound.get(docId) || {}).path || null;
export function docIdOfPath(path) {
  for (const [id, b] of bound) if (b.path === path) return id;
  return null;
}
export const ydocOf = (docId) => (bound.get(docId) || {}).ydoc || null;

/** Text offset → encoded relative position (survives the others' edits). */
export function relFromIndex(docId, index) {
  const b = bound.get(docId);
  if (!b) return null;
  const i = Math.max(0, Math.min(index, b.ytext.length));
  return b64u(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(b.ytext, i)));
}

/** Encoded relative position → text offset now, or null. */
export function indexFromRel(docId, rel) {
  const b = bound.get(docId);
  if (!b || !rel) return null;
  try {
    const abs = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(fromB64u(rel)), b.ydoc);
    return abs && abs.type === b.ytext ? abs.index : null;
  } catch (_) {
    return null;
  }
}
