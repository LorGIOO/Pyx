// User-configurable keyboard shortcuts for APP actions (TeXstudio-style).
// LaTeX snippets are commands in themselves — only application actions live
// here. Overrides persist in localStorage; tooltips read comboOf() so the UI
// always shows the live binding.

import { createMutable } from 'solid-js/store';
import { t } from '../../core/i18n.js';

// `group` is a STABLE key (also used for display via groupLabel); `label`/`en`
// are the Spanish/English display strings (see actionLabel). `id`/`def` drive
// the shortcut logic and never change with language.
export const KEY_ACTIONS = [
  { id: 'file.new', group: 'Archivo', label: 'Nuevo documento', en: 'New document', def: 'Ctrl+N' },
  { id: 'file.open', group: 'Archivo', label: 'Abrir…', en: 'Open…', def: 'Ctrl+O' },
  { id: 'file.save', group: 'Archivo', label: 'Guardar', en: 'Save', def: 'Ctrl+S' },
  { id: 'file.close', group: 'Archivo', label: 'Cerrar pestaña', en: 'Close tab', def: 'Ctrl+W' },

  { id: 'edit.find', group: 'Edición', label: 'Buscar (editor o PDF, según el foco)', en: 'Find (editor or PDF, depending on focus)', def: 'Ctrl+F' },

  { id: 'calc.runCell', group: 'Cálculo', label: 'Ejecutar la celda actual', en: 'Run the current cell', def: 'Ctrl+Enter' },
  { id: 'calc.runAdvance', group: 'Cálculo', label: 'Ejecutar celda y avanzar', en: 'Run cell and advance', def: 'Shift+Enter' },
  { id: 'calc.newCell', group: 'Cálculo', label: 'Nueva celda Python', en: 'New Python cell', def: 'Ctrl+Alt+C' },
  { id: 'calc.runAll', group: 'Cálculo', label: 'Ejecutar todas las celdas', en: 'Run all cells', def: 'Ctrl+Alt+Enter' },
  { id: 'calc.restart', group: 'Cálculo', label: 'Reiniciar el kernel', en: 'Restart the kernel', def: 'Ctrl+Alt+R' },

  { id: 'compile.run', group: 'Compilación', label: 'Compilar y ver', en: 'Compile & view', def: 'Ctrl+Shift+B' },
  { id: 'compile.live', group: 'Compilación', label: 'Compilar al escribir (alternar)', en: 'Compile on type (toggle)', def: '' },

  { id: 'view.forward', group: 'Vista', label: 'Ir a esta línea en el PDF (búsqueda directa)', en: 'Jump to this line in the PDF (forward search)', def: 'Ctrl+Alt+F' },
  { id: 'view.zen', group: 'Vista', label: 'Modo zen', en: 'Zen mode', def: 'Ctrl+Alt+Z' },
  { id: 'view.preview', group: 'Vista', label: 'Mostrar/ocultar el visor PDF', en: 'Show/hide the PDF viewer', def: 'Ctrl+Alt+P' },
  { id: 'view.terminal', group: 'Vista', label: 'Terminal', en: 'Terminal', def: 'Ctrl+Alt+T' },
  { id: 'view.split', group: 'Vista', label: 'Dividir el editor', en: 'Split the editor', def: 'Ctrl+Alt+D' },
];

// Display label for an action / a group, in the active language.
export const actionLabel = (a) => t(a.label, a.en || a.label);
export const groupLabel = (g) => ({
  Archivo: t('Archivo', 'File'),
  Edición: t('Edición', 'Edit'),
  Cálculo: t('Cálculo', 'Python'),
  Compilación: t('Compilación', 'Compile'),
  Vista: t('Vista', 'View'),
}[g] || g);

// id -> combo string override ('' = sin atajo). Reactive so the config UI and
// tooltips update live.
const overrides = createMutable(load());
function load() {
  try { return JSON.parse(localStorage.getItem('pyx-keys') || '{}'); } catch (_) { return {}; }
}
function persist() {
  try { localStorage.setItem('pyx-keys', JSON.stringify(overrides)); } catch (_) {}
}

export function comboOf(id) {
  if (id in overrides) return overrides[id];
  const a = KEY_ACTIONS.find((x) => x.id === id);
  return a ? a.def : '';
}
export function setCombo(id, combo) {
  overrides[id] = combo;
  persist();
}
export function resetCombo(id) {
  delete overrides[id];
  persist();
}
export function resetAllCombos() {
  for (const k of Object.keys(overrides)) delete overrides[k];
  persist();
}
export function conflictsOf(id) {
  const c = comboOf(id);
  if (!c) return [];
  return KEY_ACTIONS.filter((a) => a.id !== id && comboOf(a.id) === c);
}

/** Normalize a KeyboardEvent to 'Ctrl+Alt+Shift+Key' (null for bare modifiers). */
export function comboFromEvent(e) {
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return null;
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let k = e.key;
  if (k === ' ') k = 'Space';
  else if (k === 'Escape') k = 'Esc';
  else if (k.length === 1) k = k.toUpperCase();
  parts.push(k);
  return parts.join('+');
}

/** First action whose live combo matches, or null. */
export function findAction(combo) {
  if (!combo) return null;
  const a = KEY_ACTIONS.find((x) => comboOf(x.id) === combo);
  return a ? a.id : null;
}

// Handlers are registered by the app shell (main.jsx) / editor extension to
// avoid import cycles. A handler returning false means "not handled here".
const HANDLERS = {};
export function registerKeyHandlers(map) {
  Object.assign(HANDLERS, map);
}
export function runAction(id, ...args) {
  const h = HANDLERS[id];
  return h ? h(...args) !== false : false;
}
