// Unified platform layer. Wraps Tauri APIs with graceful web fallbacks so the
// UI still loads in a plain browser (`npm run dev`), where desktop-only
// features (compile, kernel, file dialogs) report that they need the app.

import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen as tauriListen, emitTo as tauriEmitTo } from '@tauri-apps/api/event';
import * as dialog from '@tauri-apps/plugin-dialog';
import * as fs from '@tauri-apps/plugin-fs';

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
      { name: 'Documentos Pyx', extensions: ['pltx', 'tex'] },
      { name: 'Pyx', extensions: ['pltx'] },
      { name: 'LaTeX', extensions: ['tex'] },
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

/* ---------- File system ---------- */
export async function readTextFile(path) {
  if (!isTauri()) return notDesktop('Leer archivo');
  return fs.readTextFile(path);
}
export async function writeTextFile(path, content) {
  if (!isTauri()) return notDesktop('Guardar archivo');
  return fs.writeTextFile(path, content);
}
export async function readBinaryFile(path) {
  if (!isTauri()) return notDesktop('Leer PDF');
  // Use the Rust command (no plugin-fs scope limit) so the PDF can be anywhere.
  const bytes = await tauriInvoke('read_file_bytes', { path });
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}
export async function writeBinaryFile(path, bytes) {
  if (!isTauri()) return notDesktop('Guardar archivo');
  return fs.writeFile(path, bytes);
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
  try { return await fs.exists(path); } catch (_) { return false; }
}

/* ---------- Backend commands (Rust) ---------- */
export const detectEnv = () => invoke('detect_env');
export const compileLatex = (path, engine, passes = 1, jobname = null) =>
  invoke('compile_latex', { path, engine, passes, jobname });
// SyncTeX inverse search: PDF position (points, top-left origin) → source+line.
export const synctexEdit = (pdf, page, x, y) => invoke('synctex_edit', { pdf, page, x, y });
// SyncTeX forward search: source file + 1-based line → PDF page/position.
export const synctexView = (tex, line, pdf) => invoke('synctex_view', { tex, line, pdf });
// .pltx container (ZIP): read → {is_zip, source}; write packs source+artifacts.
export const pltxRead = (path) => invoke('pltx_read', { path });
export const pltxWrite = (path, source) => invoke('pltx_write', { path, source });
// Installed font family names for the editor's font picker.
export const listFonts = () => invoke('list_fonts');
export const kernelStart = () => invoke('kernel_start');
export const kernelExec = (req) => invoke('kernel_exec', { req });
export const kernelReset = () => invoke('kernel_reset');
// path = null → automatic interpreter detection.
export const kernelSetPython = (path) => invoke('kernel_set_python', { path: path || null });
export const kernelInterrupt = () => invoke('kernel_interrupt');
export const listPythons = () => invoke('list_pythons');
export const revealInExplorer = (path) => invoke('reveal_in_explorer', { path });
export const openExternal = (path) => invoke('open_external', { path });
export const openViewerWindow = (path) => invoke('open_viewer_window', { path: encodeURIComponent(path) });
export const readDir = (path) => invoke('read_dir', { path });
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
