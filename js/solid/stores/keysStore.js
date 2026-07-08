// User-configurable keyboard shortcuts for APP actions (TeXstudio-style).
// LaTeX snippets are commands in themselves — only application actions live
// here. Overrides persist in localStorage; tooltips read comboOf() so the UI
// always shows the live binding.

import { createMutable } from 'solid-js/store';

export const KEY_ACTIONS = [
  { id: 'file.new', group: 'Archivo', label: 'Nuevo documento', def: 'Ctrl+N' },
  { id: 'file.open', group: 'Archivo', label: 'Abrir…', def: 'Ctrl+O' },
  { id: 'file.save', group: 'Archivo', label: 'Guardar', def: 'Ctrl+S' },
  { id: 'file.close', group: 'Archivo', label: 'Cerrar pestaña', def: 'Ctrl+W' },

  { id: 'edit.find', group: 'Edición', label: 'Buscar (editor o PDF, según el foco)', def: 'Ctrl+F' },

  { id: 'calc.runCell', group: 'Cálculo', label: 'Ejecutar la celda actual', def: 'Ctrl+Enter' },
  { id: 'calc.runAdvance', group: 'Cálculo', label: 'Ejecutar celda y avanzar', def: 'Shift+Enter' },
  { id: 'calc.newCell', group: 'Cálculo', label: 'Nueva celda Python', def: 'Ctrl+Alt+C' },
  { id: 'calc.runAll', group: 'Cálculo', label: 'Ejecutar todas las celdas', def: 'Ctrl+Alt+Enter' },
  { id: 'calc.restart', group: 'Cálculo', label: 'Reiniciar el kernel', def: 'Ctrl+Alt+R' },

  { id: 'compile.run', group: 'Compilación', label: 'Compilar y ver', def: 'Ctrl+Shift+B' },
  { id: 'compile.live', group: 'Compilación', label: 'Compilar al escribir (alternar)', def: '' },

  { id: 'view.zen', group: 'Vista', label: 'Modo zen', def: 'Ctrl+Alt+Z' },
  { id: 'view.preview', group: 'Vista', label: 'Mostrar/ocultar el visor PDF', def: 'Ctrl+Alt+P' },
  { id: 'view.terminal', group: 'Vista', label: 'Terminal', def: 'Ctrl+Alt+T' },
  { id: 'view.split', group: 'Vista', label: 'Dividir el editor', def: 'Ctrl+Alt+D' },
];

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
