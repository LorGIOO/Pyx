// Document model: create / open / save / close / switch tabs, plus the editor
// PANES (VSCode-style splits). Each text document is backed by a CodeMirror
// EditorState (managed by editor/setup); viewer documents (kind 'image'/'html')
// are tabs that render a viewer component instead of the editor.

import { state, activeDoc } from '../../core/state.js';
import { registerDoc, getDocContent, disposeDoc, getViewOfDoc } from '../../editor/setup.js';
import {
  openFileDialog,
  saveFileDialog,
  readBinaryFile,
  writeTextFile,
  writeBinaryFile,
  pltxRead,
  pltxWrite,
} from '../../core/platform.js';
import { general } from './settingsStore.js';
import { baseName } from '../../core/paths.js';
import { parseCellsText } from '../../editor/cells.js';

// A document "is Pyx" (has Python cells) when its text contains a %#python cell.
// Such a document is saved as .pltx, never .tex.
function docHasCells(doc) {
  try { return parseCellsText(getDocContent(doc.id)).length > 0; } catch (_) { return false; }
}

// Write `content` to `path` in the user-chosen encoding (UTF-8 by default).
// Non-UTF-8 encodings go through writeBinaryFile with the bytes we build here.
async function saveWithEncoding(path, content) {
  const enc = general.encoding || 'UTF-8';
  if (enc === 'UTF-8') { await writeTextFile(path, content); return; }
  let bytes;
  if (enc === 'UTF-8 con BOM') {
    const u = new TextEncoder().encode(content);
    bytes = new Uint8Array(u.length + 3);
    bytes.set([0xEF, 0xBB, 0xBF]);
    bytes.set(u, 3);
  } else {
    // Latin-1 / Windows-1252 / ASCII: one byte per code point (unmappable → '?').
    bytes = new Uint8Array(content.length);
    for (let i = 0; i < content.length; i++) {
      const c = content.charCodeAt(i);
      bytes[i] = c < 256 ? c : 0x3f;
    }
  }
  await writeBinaryFile(path, bytes);
}

const isPltxPath = (p) => /\.pltx$/i.test(p || '');

// Read a text file detecting the encoding: strict UTF-8 first, then
// windows-1252 (legacy .tex files with accents saved as latin1 stay readable).
async function readTextSmart(path) {
  const bytes = await readBinaryFile(path);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (_) {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

// Read a document's source. A .pltx is a ZIP container (source + build
// artifacts): pltxRead returns its source and extracts the artifacts next to
// it. A legacy plain-text .pltx (is_zip=false) and every other file decode as
// text. .build.tex etc. never go through here.
async function readSource(path) {
  if (isPltxPath(path)) {
    try {
      const r = await pltxRead(path);
      if (r && r.is_zip && r.source != null) return r.source;
    } catch (_) { /* fall back to plain text (legacy / corrupt) */ }
  }
  return readTextSmart(path);
}

// Persist a document's source to `path`. .pltx → ZIP container (source +
// artifacts, minus the PDF); everything else → text in the chosen encoding.
async function writeSource(path, content) {
  if (isPltxPath(path)) { await pltxWrite(path, content); return; }
  await saveWithEncoding(path, content);
}

// TeXstudio's "remove trailing whitespace on save" — applied as per-line edits
// in the editor so cursor and undo history survive.
function trimTrailingWhitespace(doc) {
  if (general.trimOnSave !== true) return;
  const view = getViewOfDoc(doc.id);
  if (!view) return;
  const changes = [];
  for (let i = 1; i <= view.state.doc.lines; i++) {
    const line = view.state.doc.line(i);
    const m = /[ \t]+$/.exec(line.text);
    if (m) changes.push({ from: line.to - m[0].length, to: line.to });
  }
  if (changes.length) view.dispatch({ changes });
}

let nextId = 1;
let nextPaneId = 2; // pane 1 exists in the initial state

export function activePane() {
  return state.panes.find((p) => p.id === state.activePaneId) || state.panes[0];
}

function syncActiveIndex() {
  const pane = activePane();
  state.activeIndex = pane && pane.docId != null
    ? state.documents.findIndex((d) => d.id === pane.docId)
    : (state.documents.length ? 0 : -1);
}

/** Make a pane the focused one (and the tab bar follow its document). */
export function focusPane(paneId) {
  if (state.activePaneId === paneId) return;
  state.activePaneId = paneId;
  syncActiveIndex();
}

/** Show an open document in a given pane. */
export function showInPane(paneId, docId) {
  const pane = state.panes.find((p) => p.id === paneId);
  const doc = state.documents.find((d) => d.id === docId);
  if (!pane || !doc) return;
  pane.docId = docId;
  state.activePaneId = paneId;
  syncActiveIndex();
}

/** Split: add a new pane right of `afterPaneId` showing `docId`. */
export function splitPane(afterPaneId, docId) {
  const idx = state.panes.findIndex((p) => p.id === afterPaneId);
  const src = state.panes[idx >= 0 ? idx : state.panes.length - 1];
  const pane = { id: nextPaneId++, docId: docId ?? src.docId };
  state.panes.splice((idx >= 0 ? idx : state.panes.length - 1) + 1, 0, pane);
  state.activePaneId = pane.id;
  syncActiveIndex();
}

export function splitActivePane() {
  splitPane(state.activePaneId);
}

export function closePane(paneId) {
  if (state.panes.length <= 1) return;
  const idx = state.panes.findIndex((p) => p.id === paneId);
  if (idx < 0) return;
  state.panes.splice(idx, 1);
  if (state.activePaneId === paneId) {
    state.activePaneId = state.panes[Math.max(0, idx - 1)].id;
  }
  syncActiveIndex();
}

/** The Python tab / cells are available in every text document — including
 * .tex, so you can drop Python cells into an existing LaTeX file. A .tex that
 * gains cells is saved as .pltx (see saveActive). Only viewer tabs are excluded. */
export function isPyxDoc(doc) {
  return !!doc && !doc.kind;
}

export function newDocument(content = '', fileName = 'sin-título.pltx', path = null) {
  const id = nextId++;
  registerDoc(id, content);
  state.documents.push({
    id,
    fileName,
    path,
    modified: false,
    engine: state.env.latex || 'xelatex',
  });
  const pane = activePane();
  pane.docId = id;
  syncActiveIndex();
  return id;
}

/** Open a cell output image as a document tab (kind 'image'). */
let viewerSeq = 1;
export function openImageTab(src, title) {
  const id = nextId++;
  state.documents.push({
    id, fileName: title || `figura-${viewerSeq++}.png`, path: null,
    modified: false, kind: 'image', payload: { src },
  });
  const pane = activePane();
  pane.docId = id;
  syncActiveIndex();
  return id;
}

/** Open rich/interactive HTML output as a document tab (kind 'html'). */
export function openHtmlTab(html, title) {
  const id = nextId++;
  state.documents.push({
    id, fileName: title || `salida-${viewerSeq++}.html`, path: null,
    modified: false, kind: 'html', payload: { html },
  });
  const pane = activePane();
  pane.docId = id;
  syncActiveIndex();
  return id;
}

export async function openDocument() {
  const path = await openFileDialog();
  if (!path) return;
  await openPath(path);
}

// Open a file by absolute path (side panel, includes, explorer).
export async function openPath(path) {
  if (!path) return;
  const existing = state.documents.findIndex((d) => d.path === path);
  if (existing >= 0) {
    switchTo(existing);
    return;
  }
  try {
    const content = await readSource(path);
    newDocument(content, baseName(path), path);
  } catch (_) { /* not a readable text file */ }
}

export function switchTo(index) {
  if (index < 0 || index >= state.documents.length) return;
  const doc = state.documents[index];
  const pane = activePane();
  pane.docId = doc.id;
  state.activeIndex = index;
}

// Recompile so the PDF always reflects the saved file (and is recreated if it
// was deleted). Lazy import avoids a static cycle with the compiler.
function autoCompile() {
  import('../../compile/compiler.js').then((m) => m.compileActive(false)).catch(() => {});
}

export async function saveActive() {
  const doc = activeDoc();
  if (!doc || doc.kind) return false; // viewer tabs aren't saveable
  trimTrailingWhitespace(doc);
  let ok;
  // A document with Python cells must be a .pltx — if it has no path yet, or it
  // was a .tex that now has cells, prompt a Save As so it lands as .pltx.
  const needsPltx = docHasCells(doc) && (!doc.path || /\.tex$/i.test(doc.path));
  if (!doc.path || needsPltx) {
    ok = await saveActiveAs();
  } else {
    await writeSource(doc.path, getDocContent(doc.id));
    doc.modified = false;
    ok = true;
  }
  if (ok) autoCompile();
  return ok;
}

export async function saveActiveAs() {
  const doc = activeDoc();
  if (!doc || doc.kind) return false;
  const cells = docHasCells(doc);
  // Default name: keep the stem but force .pltx when the document has cells.
  let defName = doc.fileName || 'documento.pltx';
  if (cells) defName = defName.replace(/\.[^.]*$/i, '') + '.pltx';
  // When it has cells the dialog only offers .pltx (no .tex option).
  const path = await saveFileDialog(defName, cells);
  if (!path) return false;
  await writeSource(path, getDocContent(doc.id));
  doc.path = path;
  doc.fileName = baseName(path);
  doc.modified = false;
  return true;
}

export async function closeDocument(index) {
  const doc = state.documents[index];
  if (!doc) return;
  if (doc.modified && !doc.kind) {
    const ok = window.confirm(`"${doc.fileName}" tiene cambios sin guardar. ¿Cerrar de todas formas?`);
    if (!ok) return;
  }
  // Free blob URLs held by image viewer tabs (explorer-opened images).
  if (doc.kind === 'image' && doc.payload && String(doc.payload.src).startsWith('blob:')) {
    try { URL.revokeObjectURL(doc.payload.src); } catch (_) { /* already gone */ }
  }
  state.documents.splice(index, 1);

  // Re-point every pane that showed this document.
  for (const pane of [...state.panes]) {
    if (pane.docId !== doc.id) continue;
    const fallback = state.documents[Math.min(index, state.documents.length - 1)];
    if (fallback) pane.docId = fallback.id;
    else if (state.panes.length > 1) closePane(pane.id);
    else pane.docId = null;
  }
  disposeDoc(doc.id);
  syncActiveIndex();
}

export function closeActive() {
  if (state.activeIndex >= 0) closeDocument(state.activeIndex);
}
