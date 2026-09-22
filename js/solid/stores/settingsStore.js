import { createSignal } from 'solid-js';
import { createMutable } from 'solid-js/store';
import { registerDialog, closeDialogs } from './dialogStore.js';

const [showConfig, setShowConfigSignal] = createSignal(false);
export { showConfig };
// Opening it closes any other dialog, and Escape closes it (dialogStore).
export const setShowConfig = (v) => {
  if (v) closeDialogs();
  setShowConfigSignal(v);
};
registerDialog(showConfig, () => setShowConfigSignal(false));

// Every customizable syntax token: a CSS class (where the color is applied) and
// the theme variable that holds its default color. Grouped like TeXstudio's
// "Formatos" dialog.
export const TOKENS = [
  // LaTeX overlay — one entry per TeXstudio format id (the names in the
  // labels are the ones TeXstudio itself uses in its "Formatos" dialog).
  // `label`/`en` = Spanish/English display strings (see ConfigDialog Row).
  { key: 'x-cmd', group: 'LaTeX', label: 'Palabra clave (\\comando)', en: 'Keyword (\\command)', cls: 'cm-lx-cmd', cssVar: '--lx-cmd' },
  { key: 'x-envkw', group: 'LaTeX', label: '\\begin / \\end', en: '\\begin / \\end', cls: 'cm-lx-envkw', cssVar: '--lx-envkw' },
  { key: 'x-sec', group: 'LaTeX', label: 'Estructura (\\section…)', en: 'Structure (\\section…)', cls: 'cm-lx-section', cssVar: '--lx-section' },
  { key: 'x-env', group: 'LaTeX', label: 'Entorno (nombre)', en: 'Environment (name)', cls: 'cm-lx-envname', cssVar: '--lx-envname' },
  { key: 'x-str', group: 'LaTeX', label: 'Título de sección', en: 'Section title', cls: 'cm-lx-structure', cssVar: '--lx-structure' },
  { key: 'x-mdel', group: 'LaTeX', label: 'Delimitadores matemáticos', en: 'Math delimiters', cls: 'cm-lx-mathdelim', cssVar: '--lx-mathdelim' },
  { key: 'x-mbody', group: 'LaTeX', label: 'Contenido matemático', en: 'Math body', cls: 'cm-lx-mathbody', cssVar: '--lx-mathbody' },
  { key: 'x-mcmd', group: 'LaTeX', label: 'Palabra clave matemática', en: 'Math keyword', cls: 'cm-lx-mathcmd', cssVar: '--lx-mathcmd' },
  { key: 'x-amp', group: 'LaTeX', label: 'Alineación (&)', en: 'Alignment (&)', cls: 'cm-lx-amp', cssVar: '--lx-amp' },
  { key: 'x-ref', group: 'LaTeX', label: 'Referencias (\\ref)', en: 'References (\\ref)', cls: 'cm-lx-ref', cssVar: '--lx-ref' },
  { key: 'x-cite', group: 'LaTeX', label: 'Citas (\\cite)', en: 'Citations (\\cite)', cls: 'cm-lx-cite', cssVar: '--lx-cite' },
  { key: 'x-pkg', group: 'LaTeX', label: 'Paquetes (\\usepackage)', en: 'Packages (\\usepackage)', cls: 'cm-lx-package', cssVar: '--lx-package' },
  { key: 'x-verb', group: 'LaTeX', label: 'Verbatim', en: 'Verbatim', cls: 'cm-lx-verbatim', cssVar: '--lx-verbatim' },
  { key: 'x-com', group: 'LaTeX', label: 'Comentario (%)', en: 'Comment (%)', cls: 'cm-lx-comment', cssVar: '--lx-comment' },
  { key: 'x-magic', group: 'LaTeX', label: 'Comentario mágico (% !TeX)', en: 'Magic comment (% !TeX)', cls: 'cm-lx-magic', cssVar: '--lx-magic' },
  { key: 'x-todo', group: 'LaTeX', label: 'Comentario TODO', en: 'TODO comment', cls: 'cm-lx-todo', cssVar: '--lx-todo' },
  { key: 'x-pic', group: 'LaTeX', label: 'Dibujo (tikzpicture)', en: 'Picture (tikzpicture)', cls: 'cm-lx-picture', cssVar: '--lx-picture' },
  { key: 'x-pickw', group: 'LaTeX', label: 'Comando de dibujo', en: 'Picture command', cls: 'cm-lx-picturekw', cssVar: '--lx-picturekw' },
  { key: 'x-py', group: 'LaTeX', label: 'Puente \\py{}', en: '\\py{} bridge', cls: 'cm-lx-py', cssVar: '--lx-py' },

  { key: 'p-ctl', group: 'Python', label: 'Control (import, for, if)', en: 'Control (import, for, if)', cls: 'cm-py-control', cssVar: '--py-control' },
  { key: 'p-sto', group: 'Python', label: 'def / class / lambda', en: 'def / class / lambda', cls: 'cm-py-storage', cssVar: '--py-storage' },
  { key: 'p-bin', group: 'Python', label: 'Funciones integradas', en: 'Built-in functions', cls: 'cm-py-builtin', cssVar: '--py-builtin' },
  { key: 'p-typ', group: 'Python', label: 'Tipos / clases', en: 'Types / classes', cls: 'cm-py-type', cssVar: '--py-type' },
  { key: 'p-fn', group: 'Python', label: 'Funciones', en: 'Functions', cls: 'cm-py-func', cssVar: '--py-func' },
  { key: 'p-str', group: 'Python', label: 'Cadenas', en: 'Strings', cls: 'cm-py-string', cssVar: '--py-string' },
  { key: 'p-num', group: 'Python', label: 'Números', en: 'Numbers', cls: 'cm-py-number', cssVar: '--py-number' },
  { key: 'p-com', group: 'Python', label: 'Comentarios', en: 'Comments', cls: 'cm-py-comment', cssVar: '--py-comment' },
  { key: 'p-op', group: 'Python', label: 'Operadores', en: 'Operators', cls: 'cm-py-operator', cssVar: '--py-operator' },
  { key: 'p-var', group: 'Python', label: 'Variables', en: 'Variables', cls: 'cm-py-variable', cssVar: '--py-variable' },
  { key: 'p-par', group: 'Python', label: 'Parámetros', en: 'Parameters', cls: 'cm-py-param', cssVar: '--py-param' },
  { key: 'p-prop', group: 'Python', label: 'Propiedades (obj.attr)', en: 'Properties (obj.attr)', cls: 'cm-py-property', cssVar: '--py-property' },
  { key: 'p-const', group: 'Python', label: 'Constantes (MAYÚSCULAS)', en: 'Constants (ALL_CAPS)', cls: 'cm-py-constant', cssVar: '--py-constant' },
  { key: 'p-ns', group: 'Python', label: 'Módulos importados', en: 'Imported modules', cls: 'cm-py-namespace', cssVar: '--py-namespace' },
  { key: 'p-logic', group: 'Python', label: 'and / or / not / in / is', en: 'and / or / not / in / is', cls: 'cm-py-logic', cssVar: '--py-logic' },
  { key: 'p-self', group: 'Python', label: 'self / cls', en: 'self / cls', cls: 'cm-py-self', cssVar: '--py-self' },
  { key: 'p-atom', group: 'Python', label: 'True / False / None', en: 'True / False / None', cls: 'cm-py-atom', cssVar: '--py-atom' },
  { key: 'p-dec', group: 'Python', label: 'Decoradores', en: 'Decorators', cls: 'cm-py-decorator', cssVar: '--py-decorator' },
  { key: 'p-esc', group: 'Python', label: 'Escapes en cadenas (\\n)', en: 'String escapes (\\n)', cls: 'cm-py-escape', cssVar: '--py-escape' },
  { key: 'p-fbr', group: 'Python', label: 'Llaves de f-string', en: 'f-string braces', cls: 'cm-py-fstring-brace', cssVar: '--py-fstring-brace' },
  // The `:.2f` of f"{x:.2f}" — VS Code paints it as storage.type.format, not
  // as part of the string.
  { key: 'p-fmt', group: 'Python', label: 'Formato de f-string (:.2f)', en: 'f-string format spec (:.2f)', cls: 'cm-py-format', cssVar: '--py-format' },
  { key: 'p-dun', group: 'Python', label: 'Nombres mágicos (__name__)', en: 'Magic names (__name__)', cls: 'cm-py-magic', cssVar: '--py-magic' },
  { key: 'p-mag', group: 'Python', label: 'Magias Jupyter (%%render)', en: 'Jupyter magics (%%render)', cls: 'cm-py-magiccmd', cssVar: '--py-magiccmd' },
];

// settings[key] = { color?, bold?, italic? } — only overrides are stored.
export const settings = createMutable(load());

function load() {
  try { return JSON.parse(localStorage.getItem('calc-syntax') || '{}'); } catch (_) { return {}; }
}
function persist() {
  try { localStorage.setItem('calc-syntax', JSON.stringify(settings)); } catch (_) {}
}

/** Default color of a token (current theme value of its CSS var), as #hex. */
export function defaultColor(token) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(token.cssVar).trim();
  return v || '#000000';
}

function styleEl() {
  let el = document.getElementById('calc-syntax-overrides');
  if (!el) {
    el = document.createElement('style');
    el.id = 'calc-syntax-overrides';
    document.head.appendChild(el);
  }
  return el;
}

export function applySettings() {
  // TeXstudio-grade per-token styling: color, bold, italic, underline,
  // strikeout, wavy underline and background — all user-overridable.
  let css = '';
  for (const t of TOKENS) {
    const s = settings[t.key];
    if (!s) continue;
    const d = [];
    if (s.color) d.push(`color:${s.color} !important`);
    if (s.bg) d.push(`background:${s.bg} !important`);
    if ('bold' in s) d.push(`font-weight:${s.bold ? '700' : '400'}`);
    if ('italic' in s) d.push(`font-style:${s.italic ? 'italic' : 'normal'}`);
    if ('underline' in s || 'strike' in s || 'wavy' in s) {
      const deco = [];
      if (s.underline) deco.push('underline');
      if (s.strike) deco.push('line-through');
      if (s.wavy && !deco.length) deco.push('underline');
      d.push(deco.length ? `text-decoration:${deco.join(' ')}${s.wavy ? ' wavy' : ''}` : 'text-decoration:none');
    }
    if (d.length) css += `.editor-host .${t.cls}{${d.join(';')}}\n`;
  }
  styleEl().textContent = css;
  persist();
}

export function setToken(key, patch) {
  settings[key] = { ...(settings[key] || {}), ...patch };
  applySettings();
}

export function resetToken(key) {
  delete settings[key];
  applySettings();
}

export function resetAll() {
  for (const k of Object.keys(settings)) delete settings[k];
  applySettings();
}

/* ---------- general settings (not syntax) ----------
 *
 * One flat, free-form object persisted in localStorage. Only the keys the user
 * actually changed are stored; everything else falls back to GENERAL_DEFAULTS,
 * so `gv(key)` is always the effective value and "restablecer" is a delete.
 *
 * Options reach the editor by two routes:
 *   - CSS (applyGeneral below) for anything that is pure appearance;
 *   - CodeMirror compartments (editor/setup.js → applyEditorSettings) for
 *     anything that is behaviour (tabulación, ajuste, autocompletado…).
 */

// Every general option and its default, grouped exactly like the dialog's
// categories so "Restablecer esta sección" knows which keys to drop.
export const GENERAL_SECTIONS = {
  general: {
    restoreSession: false,   // reopen last session's files on launch
    autosave: false,         // periodic save of the active document
    autosaveMin: 5,          // minutes between autosaves
  },
  editor: {
    fontFamily: 'Cascadia Code',
    fontSize: 13.5,
    lineHeight: 1.4,         // TeXstudio's "Line Spacing Percent"
    boldCursor: false,
    lineNumbers: true,
    folding: true,
    minimap: false,
    indentGuidesOn: true,
    activeLine: true,        // highlight the line the cursor is on
    selectionMatches: true,  // highlight other occurrences of the selection
    smoothScroll: false,
    tabSize: 4,
    indentWithSpaces: true,
    autoIndent: true,
    lineWrap: true,
    wrapColumn: 0,           // 0 = no right-margin ruler
    matchBrackets: true,
    closeBrackets: true,
    showWhitespace: false,
    showTrailingWs: false,
    trimOnSave: false,
    wheelZoom: true,
    cursorMargin: 0,         // lines kept visible above/below the cursor
  },
  complete: {
    completion: true,
    completionOnTyping: true,
    completionCaseSensitive: false,
    completionSelectFirst: true,
    completionIcons: true,
  },
  cells: {
    pythonPath: '',
    pyGhost: true,
    saveOutputs: true,
  },
  compile: {
    encoding: 'UTF-8',
    liveCompile: true,
    liveDelay: 1100,
  },
  pdf: {
    pdfFit: 'width',
    pdfInvert: false,
    loupeZoom: 3,
    selSyncPdfToCode: false,
  },
  lang: {
    spellCheck: true,
    grammarCheck: true,
  },
  syntax: {
    // 'classic' = the palette Pyx has always shipped; '2026' = VS Code's new
    // factory theme (styles/themes.css keys it off data-py-palette).
    pyPalette: 'classic',
  },
};

export const GENERAL_DEFAULTS = Object.assign({}, ...Object.values(GENERAL_SECTIONS));

export const general = createMutable(loadGeneral());
function loadGeneral() {
  try { return JSON.parse(localStorage.getItem('calc-general') || '{}'); } catch (_) { return {}; }
}

/** Effective value of a general option: the stored override, else the default.
 *  Reactive — reading a key that was never stored still tracks it. */
export function gv(key) {
  const v = general[key];
  return v === undefined ? GENERAL_DEFAULTS[key] : v;
}

const num = (v, def, lo, hi) => {
  const n = +v;
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
};

// A font family typed by hand must never be able to close the CSS rule.
const safeFont = (f) => String(f || '').replace(/["'\\{};<>]/g, '').trim();

function generalStyleEl() {
  let el = document.getElementById('calc-general-overrides');
  if (!el) { el = document.createElement('style'); el.id = 'calc-general-overrides'; document.head.appendChild(el); }
  return el;
}

export function applyGeneral() {
  let css = '';
  css += `.editor-host .cm-editor{font-size:${num(gv('fontSize'), 13.5, 6, 40)}px}\n`;
  const ff = safeFont(gv('fontFamily'));
  if (ff) css += `.editor-host .cm-content, .editor-host .cm-gutters{font-family:"${ff}", Consolas, monospace}\n`;
  // Line spacing. CodeMirror measures line blocks from the DOM and sizes the
  // gutter elements to match, so the numbers stay aligned on their own.
  css += `.editor-host .cm-content{line-height:${num(gv('lineHeight'), 1.4, 1, 3)}}\n`;
  // `!important` is required: CodeMirror's base theme declares
  // `.cm-gutter { display: flex !important }` to stop margin collapsing, so a
  // plain `display:none` here was silently ignored and both switches did
  // nothing at all.
  if (gv('lineNumbers') === false) css += `.editor-host .cm-gutter.cm-lineNumbers{display:none !important}\n`;
  if (gv('folding') === false) css += `.editor-host .cm-gutter.cm-foldGutter{display:none !important}\n`;
  if (gv('boldCursor')) css += `.editor-host .cm-cursor{border-left-width:2.5px}\n`;
  if (gv('smoothScroll')) css += `.editor-host .cm-scroller{scroll-behavior:smooth}\n`;
  // Right-margin ruler at column N (TeXstudio's WrapLineWidth). `ch` is the
  // monospace character width; 8px is the .cm-line left padding.
  const col = Math.round(num(gv('wrapColumn'), 0, 0, 300));
  if (col > 0) {
    const x = `calc(8px + ${col}ch)`;
    css += '.editor-host .cm-content{'
      + `background-image:linear-gradient(to right,transparent 0 calc(${x} - 1px),`
      + `var(--theme-border) calc(${x} - 1px) ${x},transparent ${x});`
      + 'background-repeat:no-repeat}\n';
  }
  generalStyleEl().textContent = css;
  // Python palette: themes.css defines the alternative set under
  // html[data-py-palette="2026"]; the classic one is the plain default.
  try {
    const root = document.documentElement;
    if (gv('pyPalette') === '2026') root.setAttribute('data-py-palette', '2026');
    else root.removeAttribute('data-py-palette');
  } catch (_) { /* no DOM (tests) */ }
  try { localStorage.setItem('calc-general', JSON.stringify(general)); } catch (_) {}
}

export function setGeneral(patch) {
  Object.assign(general, patch);
  applyGeneral();
}

/** Drop the overrides of one dialog section (back to the defaults). */
export function resetGeneralSection(id) {
  for (const k of Object.keys(GENERAL_SECTIONS[id] || {})) delete general[k];
  applyGeneral();
}

/** Drop EVERY general override (syntax colors and shortcuts have their own). */
export function resetGeneralAll() {
  for (const k of Object.keys(general)) delete general[k];
  applyGeneral();
}

/* ---------- session (Configuración → General → Restaurar la sesión) ---------- */
const SESSION_KEY = 'pyx-session';
/** Remember which files were open (called periodically by the app shell). */
export function setSession(paths) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(paths || [])); } catch (_) {}
}
export function getSession() {
  try {
    const a = JSON.parse(localStorage.getItem(SESSION_KEY) || '[]');
    return Array.isArray(a) ? a.filter((p) => typeof p === 'string' && p) : [];
  } catch (_) { return []; }
}

// Apply persisted overrides at startup.
export function initSettings() {
  applySettings();
  applyGeneral();
}
