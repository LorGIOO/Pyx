import { state } from '../../core/state.js';
import { emitToWindow } from '../../core/platform.js';

// `swatches` paint the chip in the settings dialog; `ink` is the colour its
// LABEL is written in. The label used to be white on every chip, which is
// unreadable on "Claro" — half of that chip is #ffffff.
export const THEMES = [
  { id: 'light', label: 'Claro', ink: 'dark', swatches: ['#ffffff', '#007acc', '#f3f3f3'] },
  { id: 'dark', label: 'Oscuro', ink: 'light', swatches: ['#1e1e1e', '#007acc', '#252526'] },
  { id: 'blue', label: 'Azul', ink: 'light', swatches: ['#0d1b2a', '#00b4d8', '#1b263b'] },
];

// What the app starts on with nothing saved (js/theme-init.js falls through to
// it, and js/core/state.js reads it back off the document element). Named here
// so "restablecer" has something to reset TO.
export const DEFAULT_THEME = 'light';

export function setTheme(id) {
  state.theme = id;
  document.documentElement.dataset.theme = id;
  try {
    localStorage.setItem('calc-theme', id);
  } catch (_) {
    /* ignore */
  }
  // Keep the detached PDF viewer window in the same theme, live.
  emitToWindow('pdf-viewer', 'theme:set', id);
}
