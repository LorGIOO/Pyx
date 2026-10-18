// Cursor history — TeXstudio's "Ir a la posición anterior / siguiente", VS
// Code's Alt+← / Alt+→: after a jump (a click far away, Ctrl+clic on a \ref,
// a search result, a SyncTeX jump, another document), Alt+← takes you back to
// where you were, and Alt+→ forward again.
//
// A position is recorded when the caret moves more than a few lines at once,
// or when the active document changes. Positions are mapped through edits, so
// they keep pointing at the same text while you type.

import { EditorView } from '@codemirror/view';
import { state as appState } from '../core/state.js';
import { docIdOf } from './doc-id.js';

const MAX = 100;
const FAR = 8; // lines: a smaller move is just navigating, not a jump
let back = [];
let fwd = [];
let navigating = false;
let last = null; // {docId, pos, line}

function same(a, b) { return a && b && a.docId === b.docId && Math.abs(a.line - b.line) < FAR; }

function push(entry) {
  if (!entry || same(back[back.length - 1], entry)) return;
  back.push(entry);
  if (back.length > MAX) back.shift();
  fwd = [];
}

export const cursorHistory = EditorView.updateListener.of((u) => {
  const st = u.state;
  const docId = docIdOf(st);
  if (u.docChanged) {
    // Keep stored positions on the same text.
    for (const list of [back, fwd]) {
      for (const e of list) if (e.docId === docId) e.pos = u.changes.mapPos(e.pos);
    }
    if (last && last.docId === docId) last.pos = u.changes.mapPos(last.pos);
  }
  if (!u.selectionSet && !u.focusChanged) return;
  if (!u.view.hasFocus && !u.selectionSet) return;
  const pos = st.selection.main.head;
  const here = { docId, pos, line: st.doc.lineAt(pos).number };
  if (!navigating && last && (last.docId !== docId || Math.abs(last.line - here.line) >= FAR)) push(last);
  last = here;
});

async function go(entry) {
  if (!entry) return false;
  const idx = appState.documents.findIndex((d) => d.id === entry.docId);
  if (idx < 0) return false;
  navigating = true;
  try {
    const { switchTo } = await import('../solid/stores/docStore.js');
    const { getViewOfDoc } = await import('./setup.js');
    if (idx !== appState.activeIndex) switchTo(idx);
    await new Promise((r) => setTimeout(r, 0));
    const v = getViewOfDoc(entry.docId);
    if (!v) return false;
    const pos = Math.min(entry.pos, v.state.doc.length);
    v.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    v.focus();
    last = { docId: entry.docId, pos, line: v.state.doc.lineAt(pos).number };
  } finally {
    setTimeout(() => { navigating = false; }, 0);
  }
  return true;
}

/** Alt+←: back to the previous position. */
export function historyBack() {
  // Drop entries of documents that were closed.
  back = back.filter((e) => appState.documents.some((d) => d.id === e.docId));
  const entry = back.pop();
  if (!entry) return false;
  if (last) fwd.push(last);
  go(entry);
  return true;
}

/** Alt+→: forward again. */
export function historyForward() {
  fwd = fwd.filter((e) => appState.documents.some((d) => d.id === e.docId));
  const entry = fwd.pop();
  if (!entry) return false;
  if (last) back.push(last);
  go(entry);
  return true;
}

/** For tests. */
export const _historyState = () => ({ back: [...back], fwd: [...fwd], last });
