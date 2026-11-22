import { state } from '../../core/state.js';
import { emitToWindow } from '../../core/platform.js';
import { t } from '../../core/i18n.js';
import { readUserFile, writeUserFile } from '../../core/userfiles.js';

// Three themes: light, dark and «Personalizado». The custom one is ONE
// stylesheet, theme.css, in Pyx's folder (next to config.json): it starts as
// a copy of every colour of the light or dark theme (its «base») and anything
// in it wins — colours, but also any rule for any part of the window
// (.ribbon-btn, .doc-tab, .cm-editor…), as in VS Code's custom CSS. Saving
// the file in Pyx, or coming back to the window after editing it elsewhere,
// applies it.
//
// `swatches` paint the chip in the settings dialog; `ink` is the colour its
// LABEL is written in.
export const THEMES = [
  { id: 'light', label: () => t('Claro', 'Light'), ink: 'dark', swatches: ['#ffffff', '#007acc', '#f3f3f3'] },
  { id: 'dark', label: () => t('Oscuro', 'Dark'), ink: 'light', swatches: ['#1e1e1e', '#007acc', '#252526'] },
  { id: 'custom', label: () => t('Personalizado', 'Custom'), ink: 'light', swatches: ['#6b4fbb', '#e8a33d', '#2d2d2d'] },
];

// What the app starts on with nothing saved (public/theme-init.js falls through to
// it, and js/core/state.js reads it back off the document element). Named here
// so "restablecer" has something to reset TO.
export const DEFAULT_THEME = 'light';
export const THEME_FILE = 'theme.css';
const BASE_KEY = 'calc-theme-base';
// The last custom CSS, so public/theme-init.js paints it before the first
// frame (no flash of the base theme at every start).
const CSS_CACHE = 'pyx-theme-css';
const STYLE_ID = 'pyx-custom-theme';

const read = (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } };
const write = (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* full */ } };

export const customBase = () => (read(BASE_KEY) === 'dark' ? 'dark' : 'light');

function injectCss(css) {
  let el = document.getElementById(STYLE_ID);
  if (!css) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ID;
  }
  // Always LAST in <head>: it must win over every stylesheet of the app.
  document.head.appendChild(el);
  if (el.textContent !== css) el.textContent = css;
}

/** Every custom property the built-in `base` theme sets, from the loaded CSS. */
function themeVariables(base) {
  const want = `[data-theme="${base}"]`;
  const vars = new Map();
  for (const sheet of [...document.styleSheets]) {
    let rules;
    try { rules = sheet.cssRules; } catch (_) { continue; }
    for (const r of rules || []) {
      if (!r.selectorText || !r.style) continue;
      const parts = r.selectorText.split(',').map((x) => x.trim());
      if (!parts.includes(want)) continue;
      for (let i = 0; i < r.style.length; i++) {
        const name = r.style[i];
        if (name.startsWith('--')) vars.set(name, r.style.getPropertyValue(name).trim());
      }
    }
  }
  return vars;
}

/** The starting theme.css: every colour of the base theme, commented. */
export function seedThemeCss(base = customBase()) {
  const vars = themeVariables(base);
  const lines = [...vars].map(([k, v]) => `  ${k}: ${v};`);
  return `/* Pyx — ${t('tema personalizado', 'custom theme')} (theme.css)
 *
 * ${t('Este archivo es el tema «Personalizado». Empezó como una copia de todos los colores',
    'This file is the «Custom» theme. It started as a copy of every colour of the')}
 * ${t(`del tema ${base === 'dark' ? 'oscuro' : 'claro'}: cambia los que quieras y guarda.`,
    `${base} theme: change any of them and save.`)}
 * ${t('Además de las variables, puedes añadir cualquier regla CSS para cualquier parte de la',
    'Besides the variables you can add any CSS rule for any part of the window, e.g.:')}
 * ${t('ventana, por ejemplo:', '')}
 *
 *   .ribbon-btn { border-radius: 6px; }
 *   .doc-tab.active { font-weight: 600; }
 *   .cm-editor { font-feature-settings: "liga" 1; }
 *
 * ${t('Pyx lo aplica al guardarlo (si lo editas en Pyx) o al volver a la ventana.',
    'Pyx applies it when you save it (if you edit it in Pyx) or when you come back to the window.')}
 */

:root[data-theme] {
${lines.join('\n')}
}
`;
}

let currentCss = '';
/** Read theme.css (writing the starting one when there is none) and apply it. */
export async function loadCustomTheme() {
  let css = await readUserFile(THEME_FILE);
  if (css == null) {
    css = seedThemeCss();
    await writeUserFile(THEME_FILE, css).catch(() => {});
  }
  if (state.theme !== 'custom') return css;
  currentCss = css;
  injectCss(css);
  write(CSS_CACHE, css);
  emitToWindow('pdf-viewer', 'theme:set', { id: customBase(), css });
  return css;
}

/** Start the theme file again from the base theme's colours. */
export async function resetCustomTheme() {
  const css = seedThemeCss();
  await writeUserFile(THEME_FILE, css);
  if (state.theme === 'custom') { currentCss = css; injectCss(css); write(CSS_CACHE, css); }
}

export function setCustomBase(base) {
  write(BASE_KEY, base === 'dark' ? 'dark' : 'light');
  if (state.theme === 'custom') {
    document.documentElement.dataset.theme = customBase();
    emitToWindow('pdf-viewer', 'theme:set', { id: customBase(), css: currentCss });
  }
}

export function setTheme(id) {
  if (!THEMES.some((th) => th.id === id)) id = id === 'blue' ? 'dark' : DEFAULT_THEME;
  state.theme = id;
  write('calc-theme', id);
  if (id === 'custom') {
    document.documentElement.dataset.theme = customBase();
    document.documentElement.dataset.customTheme = '1';
    loadCustomTheme();
    return;
  }
  delete document.documentElement.dataset.customTheme;
  injectCss('');
  document.documentElement.dataset.theme = id;
  // Keep the detached PDF viewer window in the same theme, live.
  emitToWindow('pdf-viewer', 'theme:set', { id, css: '' });
}

/** At start: «blue» (gone) becomes dark; the custom theme is (re)read. */
export function initTheme() {
  const saved = read('calc-theme');
  if (saved === 'blue') setTheme('dark');
  else if (saved === 'custom') setTheme('custom');
  // Back to the window after editing theme.css elsewhere: apply the edit.
  window.addEventListener('focus', () => { if (state.theme === 'custom') loadCustomTheme(); });
  // Saved from Pyx's own editor.
  window.addEventListener('pyx:file-saved', (e) => {
    const p = String((e.detail && e.detail.path) || '').replace(/\\/g, '/').toLowerCase();
    if (state.theme === 'custom' && p.endsWith('/' + THEME_FILE)) loadCustomTheme();
  });
}

/** Apply a theme sent by the main window (detached viewer). */
export function applyRemoteTheme(msg) {
  const o = typeof msg === 'string' ? { id: msg, css: '' } : (msg || {});
  if (o.id) document.documentElement.dataset.theme = String(o.id);
  injectCss(o.css || '');
}
