import { createSignal } from 'solid-js';
import { createMutable } from 'solid-js/store';

export const [showConfig, setShowConfig] = createSignal(false);

// Every customizable syntax token: a CSS class (where the color is applied) and
// the theme variable that holds its default color. Grouped like TeXstudio's
// "Formatos" dialog.
export const TOKENS = [
  // LaTeX granular overlay (TeXstudio-style "Formats") — one entry per construct.
  // `label`/`en` = Spanish/English display strings (see ConfigDialog Row).
  { key: 'x-cmd', group: 'LaTeX', label: 'Palabra clave (\\comando)', en: 'Keyword (\\command)', cls: 'cm-lx-cmd', cssVar: '--lx-cmd' },
  { key: 'x-sec', group: 'LaTeX', label: 'Estructura (\\section…)', en: 'Structure (\\section…)', cls: 'cm-lx-section', cssVar: '--lx-section' },
  { key: 'x-envkw', group: 'LaTeX', label: '\\begin / \\end', en: '\\begin / \\end', cls: 'cm-lx-envkw', cssVar: '--lx-envkw' },
  { key: 'x-env', group: 'LaTeX', label: 'Entorno (nombre)', en: 'Environment (name)', cls: 'cm-lx-envname', cssVar: '--lx-envname' },
  { key: 'x-pre', group: 'LaTeX', label: 'Palabra clave extra (preámbulo)', en: 'Extra keyword (preamble)', cls: 'cm-lx-preamble', cssVar: '--lx-preamble' },
  { key: 'x-ref', group: 'LaTeX', label: 'Referencias / etiquetas', en: 'References / labels', cls: 'cm-lx-ref', cssVar: '--lx-ref' },
  { key: 'x-url', group: 'LaTeX', label: 'Enlace (\\url, \\href)', en: 'Link (\\url, \\href)', cls: 'cm-lx-url', cssVar: '--lx-url' },
  { key: 'x-fmt', group: 'LaTeX', label: 'Formato de texto (\\textbf…)', en: 'Text format (\\textbf…)', cls: 'cm-lx-textfmt', cssVar: '--lx-textfmt' },
  { key: 'x-mcmd', group: 'LaTeX', label: 'Palabra clave matemática', en: 'Math keyword', cls: 'cm-lx-mathcmd', cssVar: '--lx-mathcmd' },
  { key: 'x-mdel', group: 'LaTeX', label: 'Delimitadores matemáticos ($)', en: 'Math delimiters ($)', cls: 'cm-lx-mathdelim', cssVar: '--lx-mathdelim' },
  { key: 'x-opt', group: 'LaTeX', label: 'Opciones [ ]', en: 'Options [ ]', cls: 'cm-lx-opt', cssVar: '--lx-opt' },
  { key: 'x-brace', group: 'LaTeX', label: 'Llaves { }', en: 'Braces { }', cls: 'cm-lx-brace', cssVar: '--lx-brace' },
  { key: 'x-num', group: 'LaTeX', label: 'Números y unidades', en: 'Numbers and units', cls: 'cm-lx-number', cssVar: '--lx-number' },
  { key: 'x-amp', group: 'LaTeX', label: 'Alineación (&)', en: 'Alignment (&)', cls: 'cm-lx-amp', cssVar: '--lx-amp' },
  { key: 'x-esc', group: 'LaTeX', label: 'Escapar siguiente (\\%, \\&)', en: 'Escape next (\\%, \\&)', cls: 'cm-lx-escape', cssVar: '--lx-escape' },
  { key: 'x-com', group: 'LaTeX', label: 'Comentario (%)', en: 'Comment (%)', cls: 'cm-lx-comment', cssVar: '--lx-comment' },
  { key: 'x-py', group: 'LaTeX', label: 'Puente \\py{}', en: '\\py{} bridge', cls: 'cm-lx-py', cssVar: '--lx-py' },

  { key: 'p-ctl', group: 'Python', label: 'Control (import, for, if)', en: 'Control (import, for, if)', cls: 'cm-py-control', cssVar: '--py-control' },
  { key: 'p-sto', group: 'Python', label: 'def / class / lambda', en: 'def / class / lambda', cls: 'cm-py-storage', cssVar: '--py-storage' },
  { key: 'p-kw', group: 'Python', label: 'Palabras clave', en: 'Keywords', cls: 'cm-py-keyword', cssVar: '--py-keyword' },
  { key: 'p-bin', group: 'Python', label: 'Funciones integradas', en: 'Built-in functions', cls: 'cm-py-builtin', cssVar: '--py-builtin' },
  { key: 'p-typ', group: 'Python', label: 'Tipos / clases', en: 'Types / classes', cls: 'cm-py-type', cssVar: '--py-type' },
  { key: 'p-fn', group: 'Python', label: 'Funciones', en: 'Functions', cls: 'cm-py-func', cssVar: '--py-func' },
  { key: 'p-str', group: 'Python', label: 'Cadenas', en: 'Strings', cls: 'cm-py-string', cssVar: '--py-string' },
  { key: 'p-num', group: 'Python', label: 'Números', en: 'Numbers', cls: 'cm-py-number', cssVar: '--py-number' },
  { key: 'p-com', group: 'Python', label: 'Comentarios', en: 'Comments', cls: 'cm-py-comment', cssVar: '--py-comment' },
  { key: 'p-op', group: 'Python', label: 'Operadores', en: 'Operators', cls: 'cm-py-operator', cssVar: '--py-operator' },
  { key: 'p-var', group: 'Python', label: 'Variables', en: 'Variables', cls: 'cm-py-variable', cssVar: '--py-variable' },
  { key: 'p-self', group: 'Python', label: 'self / cls', en: 'self / cls', cls: 'cm-py-self', cssVar: '--py-self' },
  { key: 'p-atom', group: 'Python', label: 'True / False / None', en: 'True / False / None', cls: 'cm-py-atom', cssVar: '--py-atom' },
  { key: 'p-dec', group: 'Python', label: 'Decoradores', en: 'Decorators', cls: 'cm-py-decorator', cssVar: '--py-decorator' },
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

/* ---------- general settings (not syntax) ---------- */
export const general = createMutable(loadGeneral());
function loadGeneral() {
  try { return JSON.parse(localStorage.getItem('calc-general') || '{}'); } catch (_) { return {}; }
}
function generalStyleEl() {
  let el = document.getElementById('calc-general-overrides');
  if (!el) { el = document.createElement('style'); el.id = 'calc-general-overrides'; document.head.appendChild(el); }
  return el;
}
export function applyGeneral() {
  let css = '';
  if (general.fontSize) css += `.editor-host .cm-editor{font-size:${general.fontSize}px}\n`;
  if (general.fontFamily) {
    css += `.editor-host .cm-content, .editor-host .cm-gutters{font-family:"${general.fontFamily}", Consolas, monospace}\n`;
  }
  if (general.lineNumbers === false) css += `.editor-host .cm-gutter.cm-lineNumbers{display:none}\n`;
  if (general.folding === false) css += `.editor-host .cm-foldGutter{display:none}\n`;
  generalStyleEl().textContent = css;
  try { localStorage.setItem('calc-general', JSON.stringify(general)); } catch (_) {}
}
export function setGeneral(patch) {
  Object.assign(general, patch);
  applyGeneral();
}

// Apply persisted overrides at startup.
export function initSettings() {
  applySettings();
  applyGeneral();
}
