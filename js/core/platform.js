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
export const compileLatex = (path, projectDir, engine, passes = 1, jobname = null, searchDirs = []) =>
  invoke('compile_latex', { path, projectDir, engine, passes, jobname, searchDirs });
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
export const kernelExec = (req) => invoke('kernel_exec', { req });
export const kernelReset = () => invoke('kernel_reset');
// path = null → automatic interpreter detection.
export const kernelSetPython = (path) => invoke('kernel_set_python', { path: path || null });
// hard = false → Jupyter-style KeyboardInterrupt (the namespace survives);
// hard = true → kill the process (for a cell that never yields to Python).
export const kernelInterrupt = (hard = false) => invoke('kernel_interrupt', { hard });
export const listPythons = () => invoke('list_pythons');
export const revealInExplorer = (path) => invoke('reveal_in_explorer', { path });
export const openExternal = (path) => invoke('open_external', { path });
export const openViewerWindow = (path) => invoke('open_viewer_window', { path: encodeURIComponent(path) });
export const readDir = (path) => invoke('read_dir', { path });
// Batched {mtime, size} for several files — lets the compiler skip re-reading
// \input'ed chapters that haven't changed on disk.
export const fileStamps = (paths) => invoke('file_stamps', { paths });
export const renamePath = (from, to) => invoke('rename_path', { from, to });
export const removePath = (path) => invoke('remove_path', { path });
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
export const runCommand = (command, cwd) => invoke('run_command', { command, cwd });
// Subscribe to streamed terminal output. Returns a Promise<unlisten>.
export function onTerminalLine(cb) {
  if (!isTauri()) return Promise.resolve(() => {});
  return tauriListen('terminal:line', (e) => cb(e.payload));
}
export function onTerminalDone(cb) {
  if (!isTauri()) return Promise.resolve(() => {});
  return tauriListen('terminal:done', (e) => cb(e.payload));
}
