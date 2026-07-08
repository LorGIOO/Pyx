// Ctrl+click file paths in the LaTeX source (VSCode/TeXstudio-style):
// \input{2. Índice/Indice_General.tex} → underlined while Ctrl is held over it,
// Ctrl+click opens the file (relative paths resolve against the document's
// folder; extensionless \input tries .tex/.pltx, images open as viewer tabs).

import { StateField, StateEffect } from '@codemirror/state';
import { EditorView, Decoration, ViewPlugin } from '@codemirror/view';
import { state as appState } from '../core/state.js';
import { pathExists, readBinaryFile, openExternal } from '../core/platform.js';
import { dirOf } from '../compile/latex-bridge.js';

const FILE_CMD =
  /\\(input|include|includegraphics|includepdf|bibliography|addbibresource|lstinputlisting)\s*(?:\[[^\]]*\])?\{([^{}]+)\}/g;

const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg']);

/** The \cmd{path} argument under `pos`, if any: {from, to, path, cmd}. */
function findPathAt(view, pos) {
  const line = view.state.doc.lineAt(pos);
  FILE_CMD.lastIndex = 0;
  let m;
  while ((m = FILE_CMD.exec(line.text))) {
    const from = line.from + m.index + m[0].length - 1 - m[2].length;
    const to = from + m[2].length;
    if (pos >= from && pos <= to) return { from, to, path: m[2], cmd: m[1] };
    if (line.from + m.index > pos) break;
  }
  return null;
}

async function openHit(hit) {
  const doc = appState.documents[appState.activeIndex];
  const base = doc && doc.path ? dirOf(doc.path) : null;
  let p = hit.path.trim().replace(/\//g, '\\');
  const isAbs = /^[a-zA-Z]:[\\/]/.test(hit.path) || hit.path.startsWith('\\\\');
  if (!isAbs) {
    if (!base) return;
    p = base + '\\' + p;
  }
  const candidates = [p];
  if (!/\.[a-z0-9]+$/i.test(p)) {
    if (hit.cmd === 'includegraphics') candidates.push(p + '.pdf', p + '.png', p + '.jpg', p + '.jpeg');
    else if (hit.cmd === 'bibliography' || hit.cmd === 'addbibresource') candidates.push(p + '.bib');
    else candidates.push(p + '.tex', p + '.pltx');
  }
  for (const c of candidates) {
    if (!(await pathExists(c))) continue;
    const ext = (c.split('.').pop() || '').toLowerCase();
    const docStore = await import('../solid/stores/docStore.js');
    if (IMG_EXT.has(ext)) {
      const bytes = await readBinaryFile(c);
      const url = URL.createObjectURL(new Blob([bytes]));
      docStore.openImageTab(url, c.split('\\').pop());
    } else if (ext === 'pdf') {
      openExternal(c); // binary PDF → system viewer
    } else {
      await docStore.openPath(c);
    }
    return;
  }
}

/* ---- Ctrl+hover underline ---- */
const setLink = StateEffect.define();
const linkField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(setLink)) {
        deco = e.value
          ? Decoration.set([Decoration.mark({ class: 'cm-path-link' }).range(e.value.from, e.value.to)])
          : Decoration.none;
      }
    }
    return deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

function currentRange(view) {
  const iter = view.state.field(linkField).iter();
  return iter.value ? { from: iter.from, to: iter.to } : null;
}

function refreshLink(view, x, y, ctrl) {
  let hit = null;
  if (ctrl && x != null) {
    const pos = view.posAtCoords({ x, y });
    if (pos != null) hit = findPathAt(view, pos);
  }
  const cur = currentRange(view);
  const same = (!hit && !cur) || (hit && cur && hit.from === cur.from && hit.to === cur.to);
  if (!same) view.dispatch({ effects: setLink.of(hit ? { from: hit.from, to: hit.to } : null) });
}

// Tracks the mouse and the Ctrl key so the underline appears/disappears live.
const linkTracker = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.view = view;
      this.x = null;
      this.y = null;
      this.onKey = (e) => {
        if (e.key === 'Control') refreshLink(this.view, this.x, this.y, e.type === 'keydown');
      };
      window.addEventListener('keydown', this.onKey);
      window.addEventListener('keyup', this.onKey);
    }
    destroy() {
      window.removeEventListener('keydown', this.onKey);
      window.removeEventListener('keyup', this.onKey);
    }
  }
);

export const pathLinks = [
  linkField,
  linkTracker,
  EditorView.domEventHandlers({
    mousemove(e, view) {
      const plugin = view.plugin(linkTracker);
      if (plugin) { plugin.x = e.clientX; plugin.y = e.clientY; }
      refreshLink(view, e.clientX, e.clientY, e.ctrlKey);
      return false;
    },
    mousedown(e, view) {
      if (e.button !== 0 || !e.ctrlKey) return false;
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos == null) return false;
      const hit = findPathAt(view, pos);
      if (!hit) return false;
      e.preventDefault();
      openHit(hit);
      return true;
    },
  }),
];
