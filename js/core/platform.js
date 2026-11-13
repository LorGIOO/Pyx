// Unified platform layer. Wraps Tauri APIs with graceful web fallbacks so the
// UI still loads in a plain browser (`npm run dev`), where desktop-only
// features (compile, kernel, file dialogs) report that they need the app.

import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen as tauriListen, emitTo as tauriEmitTo } from '@tauri-apps/api/event';
import * as dialog from '@tauri-apps/plugin-dialog';

export function isTauri() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function notDesktop(feature) {
  return Promise.reject(new Error(`${feature} requiere la app de escritorio (npm run tauri:dev).`));
}

export async function invoke(cmd, args) {
  if (!isTauri()) return notDesktop(cmd);
  return tauriInvoke(cmd, args);
}

/* ---------- Window controls ---------- */
export async function minimizeWindow() {
  if (!isTauri()) return;
  try { await getCurrentWindow().minimize(); } catch (_) {}
}
export async function toggleMaximize() {
  if (!isTauri()) return;
  try { await getCurrentWindow().toggleMaximize(); } catch (_) {}
}
export async function isMaximized() {
  if (!isTauri()) return false;
  try { return await getCurrentWindow().isMaximized(); } catch (_) { return false; }
}
export async function closeWindow() {
  if (!isTauri()) return;
  try { await getCurrentWindow().close(); } catch (_) {}
}
// Bring THIS window to the foreground (used when a Ctrl+click in the detached
// viewer opens a file in the main window's editor).
export async function focusSelf() {
  if (!isTauri()) return;
  try { const w = getCurrentWindow(); await w.unminimize(); await w.setFocus(); } catch (_) {}
}
/** Intercept EVERY way of closing this window: the title bar's X (closeWindow
 *  above), Alt+F4, the taskbar, the system menu. The handler decides; the
 *  window only goes away through destroyWindow(). */
export function onCloseRequested(handler) {
  if (!isTauri()) return () => {};
  let un = () => {};
  getCurrentWindow().onCloseRequested(handler).then((f) => { un = f; }).catch(() => {});
  return () => un();
}
/** Close this window for real (no close-requested round trip). */
export async function destroyWindow() {
  if (!isTauri()) return;
  await getCurrentWindow().destroy();
}
export function onWindowResized(cb) {
  if (!isTauri()) return () => {};
  let un = () => {};
  getCurrentWindow().onResized(cb).then((f) => { un = f; }).catch(() => {});
  return () => un();
}

/* ---------- Dialogs ---------- */
export async function openFileDialog() {
  if (!isTauri()) return null;
  return dialog.open({
    multiple: false,
    filters: [
      // `.sty` (and its siblings `.cls`/`.bib`) are project SOURCES that stay
      // in the user's folder — the only build-adjacent files Pyx never moves —
      // so they have to be openable and editable like any other source.
      { name: 'Documentos Pyx', extensions: ['pltx', 'tex', 'sty', 'cls', 'bib'] },
      { name: 'Pyx', extensions: ['pltx'] },
      { name: 'LaTeX', extensions: ['tex'] },
      { name: 'Paquetes y clases', extensions: ['sty', 'cls'] },
      { name: 'Bibliografía', extensions: ['bib'] },
      { name: 'Texto', extensions: ['txt'] },
    ],
  });
}
export async function openExeDialog() {
  if (!isTauri()) return null;
  return dialog.open({
    multiple: false,
    filters: [
      { name: 'Python', extensions: ['exe'] },
      { name: 'Todos', extensions: ['*'] },
    ],
  });
}
export async function openImageDialog() {
  if (!isTauri()) return null;
  return dialog.open({
    multiple: false,
    filters: [
      { name: 'Imágenes', extensions: ['png', 'jpg', 'jpeg', 'pdf', 'eps', 'svg'] },
      { name: 'Todos', extensions: ['*'] },
    ],
  });
}
export async function saveFileDialog(defaultName, pltxOnly = false) {
  if (!isTauri()) return null;
  // Documents with Python cells are .pltx only — don't offer a .tex option.
  const filters = pltxOnly
    ? [{ name: 'Documento Pyx', extensions: ['pltx'] }]
    : [
        { name: 'Documento Pyx', extensions: ['pltx'] },
        { name: 'LaTeX', extensions: ['tex'] },
      ];
  return dialog.save({ defaultPath: defaultName, filters });
}
export async function messageDialog(message, opts) {
  if (!isTauri()) { alert(message); return; }
  return dialog.message(message, opts);
}
/** Native yes/no. `window.confirm` is blocked in some WebView2 configurations
 *  and looks like a web page when it isn't — closing an unsaved document is a
 *  destructive choice and deserves the platform's own dialog. */
export async function askDialog(message, opts = {}) {
  if (!isTauri()) return window.confirm(message);
  return dialog.ask(message, { kind: 'warning', ...opts });
}
/** Native three-way choice — «Guardar / No guardar / Cancelar». Answers
 *  'yes' | 'no' | 'cancel'; closing the dialog (Esc, its X) is 'cancel', and
 *  so is any answer that is not recognised: the caller is about to close or
 *  replace unsaved work, so doubt must never read as consent. */
export async function choiceDialog(message, { title, kind = 'warning', yes = 'Sí', no = 'No', cancel = 'Cancelar' } = {}) {
  if (!isTauri()) return window.confirm(message) ? 'yes' : 'cancel';
  // The plugin answers with the LABEL of a custom button (or the stock
  // 'Yes' / 'No' / 'Cancel' where the platform ignores custom texts).
  const res = await dialog.message(message, { title, kind, buttons: { yes, no, cancel } });
  if (res === yes || res === 'Yes') return 'yes';
  if (res === no || res === 'No') return 'no';
  return 'cancel';
}

/* ---------- File system ----------
   Every file operation goes through Pyx's own Rust commands, never
   @tauri-apps/plugin-fs. The plugin only reaches the folders its scope lists
   (the user's home), and a project anywhere else — another drive, a USB stick,
   a network share — broke silently: `exists` answered "no" for every file
   there, so a document's \input'ed chapters were never found and the engine
   was handed a raw .pltx zip. */

/** Decode a text file the way the editor opens one: strict UTF-8 first (a BOM
 *  is dropped), then windows-1252, so a legacy .tex with accents saved as
 *  latin-1 reads correctly instead of turning every accent into "�". */
export function decodeText(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (_) {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}
export async function readTextFile(path) {
  if (!isTauri()) return notDesktop('Leer archivo');
  return decodeText(await readBinaryFile(path));
}
export async function writeTextFile(path, content) {
  if (!isTauri()) return notDesktop('Guardar archivo');
  return tauriInvoke('write_text', { path, content });
}
export async function readBinaryFile(path) {
  if (!isTauri()) return notDesktop('Leer PDF');
  // Use the Rust command (no plugin-fs scope limit) so the PDF can be anywhere.
  //
  // The command answers with `tauri::ipc::Response`, i.e. RAW BYTES that arrive
  // as an ArrayBuffer. Returning a plain `Vec<u8>` — as it used to — makes
  // Tauri serialize the file as a JSON array of numbers: a 20 MB PDF became
  // ~70 MB of text to generate, transfer and parse, on every single compile.
  const bytes = await tauriInvoke('read_file_bytes', { path });
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (bytes instanceof Uint8Array) return bytes;
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return new Uint8Array(bytes);
}
/** The bytes of a PDF for the viewer. For a compiled PDF this is the copy made
 *  when its compile ended (Rust: read_pdf) — never the file the engine may be
 *  writing again right now. */
export async function readPdfFile(path) {
  if (!isTauri()) return notDesktop('Leer PDF');
  const bytes = await tauriInvoke('read_pdf', { path });
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (bytes instanceof Uint8Array) return bytes;
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return new Uint8Array(bytes);
}
export async function writeBinaryFile(path, bytes) {
  if (!isTauri()) return notDesktop('Guardar archivo');
  // Raw body (not a JSON array of numbers); the path rides in a header.
  return tauriInvoke('write_bytes', bytes, { headers: { path: encodeURIComponent(path) } });
}
export async function savePdfDialog(defaultName) {
  if (!isTauri()) return null;
  return dialog.save({
    defaultPath: defaultName,
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
}
export async function saveImageDialog(defaultName) {
  if (!isTauri()) return null;
  return dialog.save({
    defaultPath: defaultName,
    filters: [{ name: 'Imagen PNG', extensions: ['png'] }],
  });
}
export async function pathExists(path) {
  if (!isTauri()) return false;
  try { return await tauriInvoke('path_exists', { path }); } catch (_) { return false; }
}

/* ---------- Backend commands (Rust) ---------- */
export const detectEnv = () => invoke('detect_env');
// `path` is the root .build.tex INSIDE the working directory; `projectDir` is
// the folder the engine runs from, so relative paths in the source resolve as
// the author wrote them. `searchDirs` are the folders of the \input'ed files:
// an image beside a chapter resolves, behind anything beside the main file.
// `clean` = start from nothing: no .aux, lists or SyncTeX index from earlier runs.
// `warm` = let a paused engine (preamble already typeset) run this pass;
// `prewarm` = leave one paused for the next (latex.rs, "Warm engine").
// `gen` = the app's number for this request; it comes back in the result.
export const compileLatex = (path, projectDir, engine, passes = 1, jobname = null, searchDirs = [], clean = false, warm = true, prewarm = warm, gen = 0, fastPdf = true) =>
  invoke('compile_latex', { path, projectDir, engine, passes, jobname, searchDirs, clean, warm, prewarm, gen, fastPdf });
// Stop the LaTeX run in flight (engine + PDF driver).
export const compileCancel = () => invoke('compile_cancel');
// The project's working directory (created on demand). Everything the build
// produces lives there, outside the user's folder.
export const buildDirFor = (path) => invoke('build_dir', { path });
export const copyFile = (from, to) => invoke('copy_file', { from, to });
// SyncTeX inverse search: PDF position (points, top-left origin) → source+line.
export const synctexEdit = (pdf, page, x, y) => invoke('synctex_edit', { pdf, page, x, y });
// SyncTeX forward search: source file + 1-based line → PDF page/position.
export const synctexView = (tex, line, pdf) => invoke('synctex_view', { tex, line, pdf });
// .pltx container (ZIP): read → {is_zip, source, outputs}; write packs
// source + cell results + build artifacts. `restore` unpacks the saved working
// directory too — ONLY for opening a document: a compile-time read that
// restored put the last save's build files on top of the fresh ones.
export const pltxRead = (path, restore = false) => invoke('pltx_read', { path, restore });
export const pltxWrite = (path, source, outputs = null) =>
  invoke('pltx_write', { path, source, outputs });
// Installed font family names for the editor's font picker.
export const listFonts = () => invoke('list_fonts');
export const kernelStart = () => invoke('kernel_start');
// The response arrives as the kernel's own JSON text in raw bytes (Rust no
// longer parses and re-serializes it): one decode, one parse, here.
const frameDecoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;
export async function kernelExec(req) {
  const raw = await invoke('kernel_exec', { req });
  if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) return JSON.parse(frameDecoder.decode(raw));
  if (Array.isArray(raw)) return JSON.parse(frameDecoder.decode(new Uint8Array(raw)));
  if (typeof raw === 'string') return JSON.parse(raw);
  return raw;
}
export const kernelReset = () => invoke('kernel_reset');
// path = null → automatic interpreter detection.
export const kernelSetPython = (path) => invoke('kernel_set_python', { path: path || null });
// hard = false → Jupyter-style KeyboardInterrupt (the namespace survives);
// hard = true → kill the process (for a cell that never yields to Python).
export const kernelInterrupt = (hard = false) => invoke('kernel_interrupt', { hard });
export const listPythons = () => invoke('list_pythons');
// What Pyx sets up by itself (runtime.rs): its own Python (uv) and Tectonic.
export const runtimeInfo = () => invoke('runtime_info');
export const installTectonic = () => invoke('install_tectonic');
export const setupPython = (packages = []) => invoke('setup_python', { packages });
export const installPackages = (python, packages) => invoke('install_packages', { python, packages });
// Formula recognition (image -> LaTeX): its own environment and process.
export const ocrReady = () => invoke('ocr_ready');
export const setupOcr = () => invoke('setup_ocr');
// Start the recognizer ahead of the first formula (it loads its models once).
export const ocrWarm = () => invoke('ocr_warm');
/** The picture on the system clipboard as PNG bytes, or null when there is none. */
export async function clipboardImage() {
  if (!isTauri()) return null;
  const b = await tauriInvoke('clipboard_image');
  const bytes = b instanceof ArrayBuffer ? new Uint8Array(b) : ArrayBuffer.isView(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : new Uint8Array(b || []);
  return bytes.length ? bytes : null;
}
export async function imageToLatex(bytes) {
  if (!isTauri()) return notDesktop('Imagen → LaTeX');
  return tauriInvoke('image_to_latex', bytes); // raw body: the image itself
}
export const revealInExplorer = (path) => invoke('reveal_in_explorer', { path });
export const openExternal = (path) => invoke('open_external', { path });
// A compiled PDF, in the system's PDF application: a copy of it, kept up to
// date after every compile (never the file the engine writes).
export const openPdfExternal = (path) => invoke('open_pdf_external', { path });
export const openViewerWindow = (path) => invoke('open_viewer_window', { path: encodeURIComponent(path) });
export const readDir = (path) => invoke('read_dir', { path });
// Every source file under a folder, with its text (.pltx: its document source).
export const projectTexts = (root) => invoke('project_texts', { root });
// Batched {mtime, size} for several files — lets the compiler skip re-reading
// \input'ed chapters that haven't changed on disk.
export const fileStamps = (paths) => invoke('file_stamps', { paths });
// The document source of several files in one round trip (null = unreadable):
// a .pltx gives only its source.tex, never its results or build artifacts.
export const readSources = (paths) => invoke('read_sources', { paths });
// The code cells of a Jupyter notebook ([{id, source}]): only the code crosses
// to the window, never the notebook's saved outputs.
export const readNotebook = (path) => invoke('read_notebook', { path });
export const renamePath = (from, to) => invoke('rename_path', { from, to });
// removePath deletes for good; trashPath sends to the recycle bin (Windows
// only — it rejects elsewhere, and whenever the bin cannot take the item).
export const removePath = (path) => invoke('remove_path', { path });
export const trashPath = (path) => invoke('trash_path', { path });
export const createFile = (path) => invoke('create_file', { path });
export const createDir = (path) => invoke('create_dir', { path });

/* ---------- App events ---------- */
// Subscribe to a backend-emitted event. Returns a Promise<unlisten>.
export function onAppEvent(name, cb) {
  if (!isTauri()) return Promise.resolve(() => {});
  return tauriListen(name, (e) => cb(e.payload));
}
// Send an event to another window (e.g. the detached PDF viewer). No-op if the
// target window doesn't exist.
export function emitToWindow(label, name, payload) {
  if (!isTauri()) return Promise.resolve();
  return tauriEmitTo(label, name, payload).catch(() => {});
}

/* ---------- Terminal ---------- */
// `python` = the interpreter the kernel runs: `pip`/`python` typed in the
// terminal go to THAT one, so what is installed is what the cells import.
export const runCommand = (command, cwd, python = null) => invoke('run_command', { command, cwd, python });
// Kill the command in flight (and what it started). Its `terminal:done` follows.
export const stopCommand = () => invoke('terminal_stop');
// Subscribe to streamed terminal output. Returns a Promise<unlisten>.
export function onTerminalLine(cb) {
  if (!isTauri()) return Promise.resolve(() => {});
  return tauriListen('terminal:line', (e) => cb(e.payload));
}
export function onTerminalDone(cb) {
  if (!isTauri()) return Promise.resolve(() => {});
  return tauriListen('terminal:done', (e) => cb(e.payload));
}
