// Function signatures while typing a call, and documentation on hover — inside
// Python cells, answered by the kernel (jedi, or inspect without it).
//
// Typing `(` or `,` in a call shows the signature above the cursor with the
// current parameter in bold (VSCode's parameter hints, Jupyter's Shift+Tab).
// Resting the mouse on a name shows its signature and docstring. Both go
// through kernelInspect, which never waits behind a running cell: no kernel,
// no tooltip — never a frozen editor.

import { StateField, StateEffect } from '@codemirror/state';
import { EditorView, showTooltip, hoverTooltip, keymap } from '@codemirror/view';
import { kernelInspect } from './cell-runner.js';
import { cellSource } from './autocomplete.js';

const setSig = StateEffect.define();

/** Is the caret still inside an unclosed `(` on its line? */
function insideCall(state, pos) {
  const line = state.doc.lineAt(pos);
  let depth = 0;
  const text = line.text.slice(0, pos - line.from);
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === ')') depth++;
    else if (ch === '(') { if (depth === 0) return true; depth--; }
  }
  return false;
}

function sigDom(info) {
  const dom = document.createElement('div');
  dom.className = 'cm-py-sig';
  const sig = document.createElement('code');
  const text = info.signature || info.name || '';
  // Bold the parameter being typed (jedi's index), found by position in the list.
  const open = text.indexOf('(');
  if (info.param != null && open >= 0) {
    let depth = 0, idx = 0, start = open + 1;
    const spans = [];
    for (let i = open + 1; i < text.length; i++) {
      const ch = text[i];
      if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch)) { if (depth === 0) { spans.push([start, i]); break; } depth--; }
      else if (ch === ',' && depth === 0) { spans.push([start, i]); start = i + 1; idx++; }
    }
    const span = spans[info.param];
    if (span) {
      sig.append(text.slice(0, span[0]));
      const b = document.createElement('b');
      b.textContent = text.slice(span[0], span[1]);
      sig.append(b, text.slice(span[1]));
    } else sig.textContent = text;
  } else sig.textContent = text;
  dom.appendChild(sig);
  if (info.doc) {
    const doc = document.createElement('div');
    doc.className = 'cm-py-doc';
    doc.textContent = info.doc.split('\n').slice(0, 12).join('\n');
    dom.appendChild(doc);
  }
  return dom;
}

const sigField = StateField.define({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setSig)) return e.value;
    if (!value) return null;
    if (tr.docChanged || tr.selection) {
      const pos = tr.state.selection.main.head;
      if (!insideCall(tr.state, pos)) return null;
      return { ...value, pos };
    }
    return value;
  },
  provide: (f) => showTooltip.compute([f], (state) => {
    const v = state.field(f);
    if (!v) return null;
    return { pos: v.pos, above: true, strictSide: false, arrow: false, create: () => ({ dom: sigDom(v.info) }) };
  }),
});

let timer = 0;
async function askSignature(view) {
  const pos = view.state.selection.main.head;
  const src = cellSource(view.state, pos);
  if (!src) return;
  const info = await kernelInspect(src.code, src.line, src.col);
  // Still where we asked, still inside the call?
  if (!info || !info.signature || view.state.selection.main.head !== pos) return;
  view.dispatch({ effects: setSig.of({ pos, info }) });
}

const typing = EditorView.updateListener.of((u) => {
  if (!u.docChanged) return;
  let typed = '';
  u.transactions.forEach((tr) => tr.changes.iterChanges((_a, _b, _c, _d, ins) => { typed += ins.toString(); }));
  if (typed !== '(' && typed !== '()' && typed !== ',') return;
  if (!cellSource(u.state, u.state.selection.main.head)) return;
  clearTimeout(timer);
  timer = setTimeout(() => askSignature(u.view), 120);
});

const hover = hoverTooltip(async (view, pos) => {
  const src = cellSource(view.state, pos);
  if (!src) return null;
  const line = view.state.doc.lineAt(pos);
  const text = line.text;
  let s = pos - line.from, e = s;
  while (s > 0 && /\w/.test(text[s - 1])) s--;
  while (e < text.length && /\w/.test(text[e])) e++;
  if (s === e) return null;
  // Ask about the END of the word: jedi infers what is there.
  const info = await kernelInspect(src.code, src.line, src.col + (e - (pos - line.from)));
  if (!info) return null;
  return { pos: line.from + s, end: line.from + e, above: true, create: () => ({ dom: sigDom({ ...info, param: null }) }) };
}, { hoverTime: 450 });

const closeKey = keymap.of([{
  key: 'Escape',
  run: (view) => {
    if (!view.state.field(sigField, false)) return false;
    view.dispatch({ effects: setSig.of(null) });
    return true;
  },
}]);

export const pySignatures = [sigField, typing, hover, closeKey];
