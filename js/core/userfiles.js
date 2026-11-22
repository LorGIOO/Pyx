// Pyx's own files, next to config.json (src-tauri/src/config.rs): theme.css,
// templates/…, macros.json, symbols.json. Names are relative to that folder.
//
// Outside the desktop app (the browser build used for development and tests)
// they live in localStorage under `pyx-uf:<name>`, so everything that uses
// them works the same.
import { invoke, isTauri } from './platform.js';

const LS = 'pyx-uf:';

export async function readUserFile(name) {
  if (isTauri()) return invoke('userfile_read', { name }).catch(() => null);
  try { return localStorage.getItem(LS + name); } catch (_) { return null; }
}

export async function writeUserFile(name, text) {
  if (isTauri()) return invoke('userfile_write', { name, text });
  try { localStorage.setItem(LS + name, text); } catch (_) { /* full */ }
  return undefined;
}

export async function deleteUserFile(name) {
  if (isTauri()) return invoke('userfile_delete', { name }).catch(() => {});
  try { localStorage.removeItem(LS + name); } catch (_) { /* ignore */ }
  return undefined;
}

/** File names directly inside a sub-folder ("templates/tables"), sorted. */
export async function listUserFiles(dir) {
  if (isTauri()) return invoke('userfile_list', { dir }).catch(() => []);
  const pre = LS + dir.replace(/\/+$/, '') + '/';
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(pre) && !k.slice(pre.length).includes('/')) out.push(k.slice(pre.length));
    }
  } catch (_) { /* ignore */ }
  return out.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

/** The folder's absolute path ('' outside the desktop app). */
export async function userDir() {
  if (isTauri()) return invoke('userfile_dir').catch(() => '');
  return '';
}

/** A file name from a template's title: safe on every system. */
export function fileNameOf(title, ext = '.tex') {
  const base = String(title || '').normalize('NFC').trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .slice(0, 80) || 'plantilla';
  return base + ext;
}
