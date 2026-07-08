import { state } from '../../core/state.js';
import { emitToWindow } from '../../core/platform.js';

export const THEMES = [
  { id: 'light', label: 'Claro', swatches: ['#ffffff', '#007acc', '#f3f3f3'] },
  { id: 'dark', label: 'Oscuro', swatches: ['#1e1e1e', '#007acc', '#252526'] },
  { id: 'blue', label: 'Azul', swatches: ['#0d1b2a', '#00b4d8', '#1b263b'] },
];

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
