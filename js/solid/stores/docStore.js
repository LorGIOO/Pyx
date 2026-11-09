// Document model: create / open / save / close / switch tabs, plus the editor
// PANES (VSCode-style splits). Each text document is backed by a CodeMirror
// EditorState (managed by editor/setup); viewer documents (kind 'image'/'html')
// are tabs that render a viewer component instead of the editor.

import { state, activeDoc } from '../../core/state.js';
import {
  registerDoc, getDocContent, disposeDoc, getViewOfDoc, broadcastCellRefresh,
} from '../../editor/setup.js';
import {
  openFileDialog,
  saveFileDialog,
  readBinaryFile,
  decodeText,
  writeTextFile,
  writeBinaryFile,
  pltxRead,
  pltxWrite,
  choiceDialog,
  messageDialog,
} from '../../core/platform.js';
import { t } from '../../core/i18n.js';
import { general } from './settingsStore.js';
import { baseName } from '../../core/paths.js';
import { parseCellsText, codeHashMap } from '../../editor/cell-parse.js';
import { serializeDoc, hydrateDoc, clearDoc } from '../../editor/cell-outputs.js';

// A document "is Pyx" (has Python cells) when its text contains a %#python cell.
// Such a document is saved as .pltx, never .tex.
function docHasCells(doc) {
  try { return parseCellsText(getDocContent(doc.id)).length > 0; } catch (_) { return false; }
}

// Write `content` to `path` in the user-chosen encoding (UTF-8 by default).
// Non-UTF-8 encodings go through writeBinaryFile with the bytes we build here.
// The compiler writes the sources it builds through THIS too: it used plain
// UTF-8, so compiling a Latin-1 document re-encoded the author's file behind
// their back (and broke `\usepackage[latin1]{inputenc}` under pdflatex).
export async function saveWithEncoding(path, content) {
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
// The compiler reads \input'ed chapters through the same decoder.
async function readTextSmart(path) {
  return decodeText(await readBinaryFile(path));
}

// Read a document's source FOR OPENING. A .pltx is a ZIP container (source +
// cell results + working directory): this is the one read that restores the
// working directory, so its saved PDF can be shown at once. A legacy
// plain-text .pltx (is_zip=false) and every other file decode as text.
//
// Returns `{ text, outputs }`; `outputs` is the serialized cell-result store
// saved with the document, or null.
async function readSource(path) {
  if (isPltxPath(path)) {
    try {
      const r = await pltxRead(path, true);
      if (r && r.is_zip) return { text: r.source, outputs: r.outputs || null };
    } catch (e) {
      // A .pltx that IS a container but cannot be read is DAMAGED, and the
      // fallback below would open its bytes as if they were the document:
      // the editor filled with zip bytes, no warning at all, and one Ctrl+S
      // would have packed that as a perfectly valid .pltx over the original.
      // Only a legacy plain-text .pltx (not a zip at all) may fall through.
      const head = await readBinaryFile(path).catch(() => null);
      if (!head || (head[0] === 0x50 && head[1] === 0x4B)) throw e; // "PK"
    }
  }
  return { text: await readTextSmart(path), outputs: null };
}

/* Persist a document's source to `path`.
 *
 * .pltx → ZIP container: source + cell results + build artifacts, minus the
 * PDF. Everything else → text in the chosen encoding.
 *
 * The RESULTS travel with the document on purpose. An engineering report is
 * read far more often than it is recomputed, and reopening one had to re-run
 * every cell — minutes of simulation — just to see numbers that were already
 * settled. Saving them keeps the document usable on a machine with no Python
 * at all, and cell-outputs.js caps how much figure data may go in so the file
 * stays close to the size of its text. */
async function writeSource(path, content, doc) {
  if (isPltxPath(path)) {
    let outputs = null;
    if (doc && general.saveOutputs !== false) {
      try {
        outputs = serializeDoc(doc.id, codeHashMap(parseCellsText(content)));
      } catch (_) { outputs = null; }
    }
    await pltxWrite(path, content, outputs);
    return;
  }
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
    // No engine until the user picks one in Configuración. A default stored
    // here counted as that explicit choice, so `% !TeX program = pdflatex` in
    // the document never applied; the compiler falls back to the detected
    // engine by itself.
    engine: undefined,
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

/** Open a document the OS handed us (double-clicked .pltx, "Open with…", a
 *  second launch while the app is already running). */
export async function openFromOs(paths) {
  for (const p of paths || []) {
    if (typeof p === 'string' && /\.(pltx|tex|sty|cls|bib|txt)$/i.test(p)) await openPath(p);
  }
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
    const { text, outputs } = await readSource(path);
    const id = newDocument(text, baseName(path), path);
    // Restore the results saved with the document. Anything whose cell has
    // changed since is dropped by the store — a number that no longer matches
    // its formula must never come back looking current.
    if (outputs) {
      hydrateDoc(id, outputs, codeHashMap(parseCellsText(text)));
      // Repaint the cells: their badges are drawn when the editor mounts, and
      // the results arrive here, right after. Without this a document reopened
      // with its results showed every cell as never run — while its PDF
      // displayed the very numbers those cells had produced.
      broadcastCellRefresh();
    }
    // Its saved PDF, at once — no compile needed to see a document you opened.
    // …and the kernel starts importing what the document's cells need, so its
  // first compile does not wait for scipy and matplotlib to load.
  import('../../compile/compiler.js').then((m) => { m.showSavedPdf(); m.prewarmActive(); }).catch(() => {});
  } catch (e) {
    // Say why. A damaged .pltx used to open silently as raw bytes.
    await messageDialog(`No se pudo abrir «${baseName(path)}».\n\n${String((e && e.message) || e)}`,
      { title: 'No se pudo abrir el documento', kind: 'error' }).catch(() => {});
  }
}

export function switchTo(index) {
  if (index < 0 || index >= state.documents.length) return;
  const doc = state.documents[index];
  const pane = activePane();
  pane.docId = doc.id;
  state.activeIndex = index;
  // The viewer follows the document you are looking at: its project's PDF, if
  // there is a current one. Without this, switching to another project left
  // the previous one's PDF on screen with nothing saying so. (A chapter and
  // its root share a PDF, so moving between them changes nothing.)
  import('../../compile/compiler.js').then((m) => m.showSavedPdf()).catch(() => {});
}

// Saving is "I'm done with this change — show me". It compiles EVERYTHING the
// document needs, cells and LaTeX, and brings up the viewer: the same as
// "Compilar y ver". It used to be a background compile, which left the viewer
// closed if it was closed, so Ctrl+S looked like it only saved.
// Not forced: when the live compile already built exactly this text, a save
// shows that PDF instead of running LaTeX again for the same bytes (an
// explicit "Compilar" still forces). Lazy import avoids a static cycle.
function compileAfterSave() {
  import('../../compile/compiler.js').then((m) => m.compileActive(true, { force: false })).catch(() => {});
}

/* A save that fails must never look like one that worked.
 *
 * Writing can fail for ordinary reasons — the file is read-only, the network
 * drive dropped, the disk is full — and nothing said so: the rejected promise
 * died unheard, the document was left looking saved, and the status bar even
 * went green because the live compile (which builds from the editor's text,
 * not from disk) had just succeeded. The user's work was only in memory.
 *
 * So: the document stays MODIFIED, the reason goes to «Problemas», and the
 * platform's own error dialog says it out loud. Nothing is compiled after a
 * failed save. */
async function saveFailed(doc, e, interactive = true) {
  const msg = String((e && e.message) || e);
  state.lastLog = `===== Avisos de Pyx =====\n[Guardar · ${doc.fileName}] ${msg}`;
  // An unattended save (autosave) must not put up a modal every few minutes
  // while a drive is away: the log carries it and the document stays marked.
  if (!interactive) return false;
  try {
    await messageDialog(`No se pudo guardar «${doc.fileName}».\n\n${msg}`,
      { title: 'El documento NO se ha guardado', kind: 'error' });
  } catch (_) { /* no dialog here: the log still carries it */ }
  return false;
}

/* Text typed WHILE a save is in flight must not come out marked as saved.
 *
 * Writing is asynchronous (a network drive, a large .pltx being packed), and
 * the editor stays usable meanwhile. Clearing `modified` after the `await`
 * declared the document saved whatever had been typed in between: the tab
 * lost its dot, closing asked nothing, and those characters existed only in
 * memory. So the flag is cleared only when the buffer still IS the text that
 * was written.
 *
 * Exported for the compiler, which also saves the sources it builds from. */
export function markSavedIfUnchanged(doc, textWritten) {
  if (!doc) return false;
  let now;
  try { now = getDocContent(doc.id); } catch (_) { return false; }
  if (now !== textWritten) {
    doc.modified = true;
    return false;
  }
  doc.modified = false;
  return true;
}

// One write per document at a time: Ctrl+S twice in a row, or an autosave
// landing on a manual save, would otherwise race two writers on one file.
const saving = new Map(); // doc id -> Promise of the save in flight
function serialized(doc, job) {
  const prev = saving.get(doc.id) || Promise.resolve();
  const next = prev.catch(() => {}).then(job);
  saving.set(doc.id, next);
  const done = () => { if (saving.get(doc.id) === next) saving.delete(doc.id); };
  next.then(done, done);
  return next;
}

/** Save ANY open document (not only the active one) through the real save
 *  path: a .pltx is packed as a container, an untitled document — or a .tex
 *  that gained cells — goes through «Guardar como».
 *
 *    compile     — compile and show afterwards (an explicit Ctrl+S).
 *    trim        — apply «quitar espacios al final» first.
 *    interactive — may open dialogs. Off, a document that would need
 *                  «Guardar como» is left alone and a failure is only logged. */
export function saveDocument(doc, { compile = false, trim = true, interactive = true } = {}) {
  if (!doc || doc.kind) return Promise.resolve(false); // viewer tabs aren't saveable
  return serialized(doc, async () => {
    if (trim) trimTrailingWhitespace(doc);
    let ok;
    // A document with Python cells must be a .pltx — if it has no path yet, or it
    // was a .tex that now has cells, prompt a Save As so it lands as .pltx.
    const needsPltx = docHasCells(doc) && (!doc.path || /\.tex$/i.test(doc.path));
    if (!doc.path || needsPltx) {
      if (!interactive) return false;
      ok = await writeAs(doc);
    } else {
      const content = getDocContent(doc.id);
      try {
        await writeSource(doc.path, content, doc);
      } catch (e) {
        return saveFailed(doc, e, interactive);
      }
      markSavedIfUnchanged(doc, content);
      ok = true;
    }
    if (ok && compile) compileAfterSave();
    return ok;
  });
}

// «Guardar como» for one document. The dialog is about THAT document, so it
// is brought to the front first: asked while closing the app, the name on the
// dialog must match the text the user is looking at.
async function writeAs(doc) {
  const index = state.documents.findIndex((d) => d.id === doc.id);
  if (index < 0) return false;
  if (index !== state.activeIndex) switchTo(index);
  const cells = docHasCells(doc);
  // Default name: keep the stem but force .pltx when the document has cells.
  let defName = doc.fileName || 'documento.pltx';
  if (cells) defName = defName.replace(/\.[^.]*$/i, '') + '.pltx';
  // When it has cells the dialog only offers .pltx (no .tex option).
  const path = await saveFileDialog(defName, cells);
  if (!path) return false;
  const content = getDocContent(doc.id);
  try {
    await writeSource(path, content, doc);
  } catch (e) {
    return saveFailed({ ...doc, fileName: baseName(path) }, e);
  }
  doc.path = path;
  doc.fileName = baseName(path);
  markSavedIfUnchanged(doc, content);
  return true;
}

export function saveActive() {
  return saveDocument(activeDoc(), { compile: true });
}

export function saveActiveAs() {
  const doc = activeDoc();
  if (!doc || doc.kind) return Promise.resolve(false);
  return serialized(doc, () => writeAs(doc));
}

/** Open documents with changes that are not on disk (viewer tabs never are). */
export function unsavedDocs() {
  return state.documents.filter((d) => d.modified && !d.kind);
}

/* Before anything that throws the open documents away — closing the window,
 * installing an update — ask what to do with the unsaved ones.
 *
 * Returns true when it is safe to go on: nothing was modified, everything was
 * saved, or the user chose to discard. «Guardar» uses the real save path for
 * each document (a .pltx is packed, an untitled one asks where to go); a
 * cancelled «Guardar como» or a failed write answers false — the app stays
 * open with the document still marked. It asks again if something was typed
 * while the saves ran. */
export async function resolveUnsaved({ title, lead } = {}) {
  for (;;) {
    const docs = unsavedDocs();
    if (!docs.length) return true;
    const names = docs.slice(0, 10).map((d) => `   •  ${d.fileName}`);
    if (docs.length > 10) names.push(t(`   … y ${docs.length - 10} más`, `   … and ${docs.length - 10} more`));
    const what = docs.length === 1
      ? t('Este documento tiene cambios sin guardar:', 'This document has unsaved changes:')
      : t('Estos documentos tienen cambios sin guardar:', 'These documents have unsaved changes:');
    const choice = await choiceDialog(
      `${lead ? `${lead}\n\n` : ''}${what}\n\n${names.join('\n')}\n\n${t('¿Quieres guardarlos?', 'Do you want to save them?')}`,
      {
        title: title || t('Cambios sin guardar', 'Unsaved changes'),
        yes: docs.length === 1 ? t('Guardar', 'Save') : t('Guardar todo', 'Save all'),
        no: t('No guardar', "Don't save"),
        cancel: t('Cancelar', 'Cancel'),
      },
    );
    if (choice === 'cancel') return false;
    if (choice === 'no') return true;
    for (const d of docs) {
      // Closed or saved by other means while an earlier dialog was up.
      if (!d.modified || !state.documents.some((x) => x.id === d.id)) continue;
      if (!(await saveDocument(d))) return false;
    }
  }
}

export async function closeDocument(index) {
  const doc = state.documents[index];
  if (!doc) return;
  if (doc.modified && !doc.kind) {
    const choice = await choiceDialog(
      t(`«${doc.fileName}» tiene cambios sin guardar. ¿Quieres guardarlos antes de cerrarlo?`,
        `"${doc.fileName}" has unsaved changes. Save them before closing it?`),
      {
        title: t('Cerrar documento', 'Close document'),
        yes: t('Guardar', 'Save'),
        no: t('No guardar', "Don't save"),
        cancel: t('Cancelar', 'Cancel'),
      },
    );
    if (choice === 'cancel') return;
    if (choice === 'yes' && !(await saveDocument(doc))) return;
    // The dialogs were asynchronous: tabs may have been closed or reordered.
    index = state.documents.findIndex((d) => d.id === doc.id);
    if (index < 0) return;
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
  // Results can hold megabytes of figures; a closed document keeps none.
  clearDoc(doc.id);
  syncActiveIndex();
}

export function closeActive() {
  if (state.activeIndex >= 0) closeDocument(state.activeIndex);
}
