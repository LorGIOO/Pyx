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
  writeTextFile,
  writeBinaryFile,
  pltxRead,
  pltxWrite,
  askDialog,
  choiceDialog,
  messageDialog,
} from '../../core/platform.js';
import { t } from '../../core/i18n.js';
import {
  decodeBytes, encodeText, formatFromSetting, encodingLabel,
} from '../../core/encoding.js';
import { general } from './settingsStore.js';
import { baseName, normalizePath, samePath } from '../../core/paths.js';
import { parseCellsText, codeHashMap } from '../../editor/cell-parse.js';
import { serializeDoc, hydrateDoc, clearDoc } from '../../editor/cell-outputs.js';

// A document "is Pyx" (has Python cells) when its text contains a %#python cell.
// Such a document is saved as .pltx, never .tex.
function docHasCells(doc) {
  try { return parseCellsText(getDocContent(doc.id)).length > 0; } catch (_) { return false; }
}

/* How a document is stored on disk: {encoding, bom, eol}.
 *
 * Each document carries its OWN, detected when it was opened, and every save
 * gives the file back that way (core/encoding.js says why). The setting in
 * Configuración → Archivos is what NEW documents get — and files that are
 * pure ASCII, whose bytes cannot say which encoding they are in. */
export function defaultFormat() {
  return formatFromSetting(general.encoding || 'UTF-8');
}
function formatOf(doc) {
  return (doc && doc.format) || defaultFormat();
}
function detectedFormat(d) {
  return { encoding: d.ascii ? defaultFormat().encoding : d.encoding, bom: d.bom, eol: d.eol };
}

/** The user picked another encoding in Configuración: that is an explicit
 *  "store my files like this", so it applies to the documents that are open
 *  (their line endings stay as they are). Files opened later keep their own. */
export function applyEncodingSetting() {
  const def = defaultFormat();
  for (const d of state.documents) {
    if (d.kind || !d.format) continue;
    d.format = { ...d.format, encoding: def.encoding, bom: def.bom };
  }
}

const listChars = (chars) => chars.slice(0, 12).map((c) => `«${c}»`).join(' ')
  + (chars.length > 12 ? ' …' : '');

/* Write `content` to `path` the way that file is stored on disk.
 *
 * The compiler writes the sources it builds through THIS too (it used plain
 * UTF-8, so compiling a Latin-1 document re-encoded the author's file behind
 * their back and broke `\usepackage[latin1]{inputenc}` under pdflatex). It
 * passes only (path, content): the format is the open document's.
 *
 * A character the file's encoding cannot hold is never written as "?" — that
 * destroyed text with no warning. An interactive save offers to store the
 * file as UTF-8 instead; an unattended one (the compiler, autosave) refuses
 * with an error that says which characters and what to do. */
export async function saveWithEncoding(path, content, { doc, interactive = false } = {}) {
  const owner = doc || state.documents.find((d) => !d.kind && samePath(d.path, path)) || null;
  let format = formatOf(owner);
  let { bytes, unmappable } = encodeText(content, format);
  if (unmappable.length) {
    const name = baseName(path);
    const enc = encodingLabel(format.encoding);
    if (!interactive) {
      throw new Error(t(
        `«${name}» está en ${enc} y contiene caracteres que esa codificación no tiene: ${listChars(unmappable)}. No se ha guardado para no perderlos. Guarda con Ctrl+S y elige UTF-8, o quita esos caracteres.`,
        `"${name}" is stored as ${enc} and contains characters that encoding lacks: ${listChars(unmappable)}. It was not saved, so as not to lose them. Save with Ctrl+S and choose UTF-8, or remove those characters.`,
      ));
    }
    const toUtf8 = await askDialog(t(
      `«${name}» está guardado en ${enc}, que no tiene estos caracteres:\n\n${listChars(unmappable)}\n\nSi se guardara así se perderían. ¿Guardar el archivo en UTF-8?`,
      `"${name}" is stored as ${enc}, which lacks these characters:\n\n${listChars(unmappable)}\n\nSaved that way they would be lost. Save the file as UTF-8?`,
    ), {
      title: t('Caracteres que no caben en la codificación', 'Characters the encoding cannot hold'),
      okLabel: t('Guardar en UTF-8', 'Save as UTF-8'),
      cancelLabel: t('Cancelar', 'Cancel'),
    });
    if (!toUtf8) {
      const e = new Error(t('Guardado cancelado.', 'Save cancelled.'));
      e.cancelled = true; // the user's choice, not a failure to report
      throw e;
    }
    format = { ...format, encoding: 'utf-8', bom: false };
    ({ bytes } = encodeText(content, format));
    if (owner) owner.format = format;
  }
  // Plain UTF-8 with LF goes as text (no byte array across the bridge).
  if (format.encoding === 'utf-8' && !format.bom && format.eol === '\n' && !content.includes('\r')) {
    await writeTextFile(path, content);
    return;
  }
  await writeBinaryFile(path, bytes);
}

const isPltxPath = (p) => /\.pltx$/i.test(p || '');

// Read a document's source FOR OPENING. A .pltx is a ZIP container (source +
// cell results + working directory): this is the one read that restores the
// working directory, so its saved PDF can be shown at once. A legacy
// plain-text .pltx (is_zip=false) and every other file decode as text.
//
// Returns `{ text, outputs, format }`; `outputs` is the serialized cell-result
// store saved with the document, or null; `format` is how a TEXT file is
// stored (encoding, BOM, line endings), or null for a container.
async function readSource(path) {
  if (isPltxPath(path)) {
    try {
      const r = await pltxRead(path, true);
      if (r && r.is_zip) return { text: r.source, outputs: r.outputs || null, format: null };
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
  // Strict UTF-8 first, then windows-1252 (legacy .tex files with accents
  // saved as latin1 stay readable) — the compiler reads \input'ed chapters
  // through the same decoder. What was detected is kept for saving.
  const d = decodeBytes(await readBinaryFile(path));
  return { text: d.text, outputs: null, format: detectedFormat(d) };
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
async function writeSource(path, content, doc, interactive = true) {
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
  await saveWithEncoding(path, content, { doc, interactive });
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

export function newDocument(content = '', fileName = 'sin-título.pltx', path = null, format = null) {
  const id = nextId++;
  registerDoc(id, content);
  state.documents.push({
    id,
    fileName,
    path,
    modified: false,
    // {encoding, bom, eol} of the file this came from; null = a new document
    // (or a container), stored as Configuración → Archivos says.
    format,
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

/* Open a file by absolute path (side panel, includes, explorer).
 *
 * One tab per FILE. The check used to compare the path strings as they came
 * (`C:\p\a.tex` ≠ `C:/p/./a.tex` ≠ `c:\P\A.TEX`) and only against documents
 * that had finished opening — and the file tree opens on a single click, so
 * a double click started two reads of the same file and produced two tabs.
 * Two tabs on one file is a data-loss bug: saving the stale one silently
 * overwrites what the other just wrote. So the comparison is on the
 * normalized path, and an open in flight is shared, not repeated. */
const opening = new Map(); // normalized path -> Promise of the open in flight
const pathKey = (p) => normalizePath(p).replace(/\\/g, '/').toLowerCase();

export function openPath(path) {
  if (!path) return Promise.resolve();
  const key = pathKey(path);
  const flying = opening.get(key);
  if (flying) return flying;
  const p = openPathNow(path);
  opening.set(key, p);
  const done = () => { if (opening.get(key) === p) opening.delete(key); };
  p.then(done, done);
  return p;
}

async function openPathNow(path) {
  const existing = state.documents.findIndex((d) => !d.kind && samePath(d.path, path));
  if (existing >= 0) {
    switchTo(existing);
    return;
  }
  try {
    const { text, outputs, format } = await readSource(path);
    const id = newDocument(text, baseName(path), path, format);
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

/** A file or folder was renamed (side panel): the open documents follow it.
 *  Their tabs used to keep the old path, so the next Ctrl+S quietly re-created
 *  the file under its old name, beside the renamed one. */
export function pathRenamed(from, to) {
  if (!from || !to) return;
  const strip = (p) => normalizePath(p).replace(/[\\/]+$/, '');
  const base = strip(from);
  const key = pathKey(base);
  for (const d of state.documents) {
    if (d.kind || !d.path) continue;
    const mine = normalizePath(d.path);
    const k = pathKey(mine);
    if (k === key) {
      d.path = to;
      d.fileName = baseName(to);
    } else if (k.startsWith(`${key}/`)) {
      // Inside a renamed folder: the same tail under the new folder.
      d.path = strip(to) + mine.slice(base.length);
    }
  }
}

/** A file or folder was deleted (side panel). A document with nothing unsaved
 *  closes with its file; one with unsaved edits stays — that text now exists
 *  nowhere else — and stays marked, so Ctrl+S can put it back. */
export function pathRemoved(path) {
  if (!path) return;
  const key = pathKey(normalizePath(path).replace(/[\\/]+$/, ''));
  for (const d of [...state.documents]) {
    if (d.kind || !d.path) continue;
    const k = pathKey(d.path);
    if (k !== key && !k.startsWith(`${key}/`)) continue;
    if (d.modified) continue;
    const i = state.documents.findIndex((x) => x.id === d.id);
    if (i >= 0) closeDocument(i);
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
        await writeSource(doc.path, content, doc, interactive);
      } catch (e) {
        if (e && e.cancelled) return false; // the user backed out of a question
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
    if (e && e.cancelled) return false;
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

/* Autosave (Configuración → General): EVERY open document that has a file
 * and unsaved changes — not just the one in front, which left the chapters
 * edited in other tabs exactly as unprotected as with autosave off.
 *
 * It is unattended, and went through the same code as Ctrl+S, so every few
 * minutes it also did what only an explicit save should:
 *   - opened «Guardar como» on a .tex that had gained Python cells;
 *   - compiled and brought the PDF viewer up;
 *   - trimmed trailing whitespace — i.e. deleted the space just typed, under
 *     the cursor, in the middle of a sentence.
 * None of that here: it writes the text as it is and nothing else. A document
 * that would need a dialog is left for the user's own save. */
export async function autosaveAll() {
  let saved = 0;
  for (const d of [...state.documents]) {
    if (d.kind || !d.path || !d.modified) continue;
    if (await saveDocument(d, { compile: false, trim: false, interactive: false })) saved++;
  }
  return saved;
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
