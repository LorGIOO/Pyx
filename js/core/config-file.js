// Settings mirrored to a readable file (src-tauri/src/config.rs).
//
// The window reads its settings from localStorage at start — instant, no
// round trip to the disk. Every change is ALSO written, a second later, to
// config.json in the user's settings folder (%APPDATA%\Pyx on Windows), as
// plain JSON: something a person can read, back up, or copy to another
// computer. When localStorage comes back empty (the WebView's data was wiped,
// a reinstall), the settings are restored from that file.
import { invoke, isTauri } from './platform.js';

// Per-document data (annotations of each PDF, …) stays out: settings only.
const SKIP = /^(pyx-annot:|pyx-annot-doc|pdf-annots|pyx-dd-mem$)/;
const MAX_VALUE = 256 * 1024;
const MARK = 'pyx-config-restored';

function snapshot() {
  const settings = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || SKIP.test(k) || k === MARK) continue;
    const v = localStorage.getItem(k);
    if (v == null || v.length > MAX_VALUE) continue;
    // Nested JSON is stored as objects, so the file reads like a settings
    // file and not like a list of escaped strings.
    try { settings[k] = { json: JSON.parse(v) }; } catch (_) { settings[k] = { text: v }; }
  }
  return settings;
}

let timer = null;
let lastWritten = '';
function scheduleWrite() {
  if (!isTauri()) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    const body = JSON.stringify({ app: 'Pyx', version: 1, saved: new Date().toISOString(), settings: snapshot() }, null, 2);
    const cmp = body.replace(/"saved": "[^"]*",?/, '');
    if (cmp === lastWritten) return;
    lastWritten = cmp;
    invoke('config_write', { text: body }).catch(() => { lastWritten = ''; });
  }, 1000);
}

/** Write a whole settings object into localStorage. */
function apply(settings) {
  let n = 0;
  for (const [k, v] of Object.entries(settings || {})) {
    if (!v || typeof v !== 'object') continue;
    const val = 'json' in v ? JSON.stringify(v.json) : typeof v.text === 'string' ? v.text : null;
    if (val == null) continue;
    try { localStorage.setItem(k, val); n++; } catch (_) { /* full */ }
  }
  return n;
}

/** Parse the text of a config.json; null when it is not one. */
export function parseConfig(text) {
  try {
    const o = JSON.parse(text);
    return o && o.app === 'Pyx' && o.settings && typeof o.settings === 'object' ? o.settings : null;
  } catch (_) { return null; }
}

/**
 * Start mirroring. Call once, early. Resolves true when it restored the
 * settings from the file — the caller then reloads, so every store reads them.
 */
export async function initConfigFile() {
  if (!isTauri() || typeof localStorage === 'undefined') return false;
  // Every write to localStorage schedules the mirror; nothing else to wire.
  const proto = Object.getPrototypeOf(localStorage);
  for (const m of ['setItem', 'removeItem', 'clear']) {
    const orig = proto[m];
    if (orig.__pyxMirror) continue;
    const wrapped = function (...a) { const r = orig.apply(this, a); if (this === localStorage) scheduleWrite(); return r; };
    wrapped.__pyxMirror = true;
    proto[m] = wrapped;
  }
  const empty = !localStorage.getItem('calc-general') && !localStorage.getItem('calc-theme') && !localStorage.getItem('pyx-keys');
  if (empty && !sessionStorage.getItem(MARK)) {
    const settings = parseConfig(await invoke('config_read').catch(() => null));
    if (settings && apply(settings) > 0) {
      sessionStorage.setItem(MARK, '1'); // once: never a reload loop
      return true;
    }
  }
  scheduleWrite(); // the file exists and is current from the first start on
  return false;
}

/** «Importar configuración»: replace the settings with those of a file. */
export function importConfigText(text) {
  const settings = parseConfig(text);
  if (!settings) return false;
  apply(settings);
  return true;
}

/** «Exportar configuración»: the text of a config.json for the current settings. */
export function exportConfigText() {
  return JSON.stringify({ app: 'Pyx', version: 1, saved: new Date().toISOString(), settings: snapshot() }, null, 2);
}
