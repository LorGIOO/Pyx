// Editor features TeXstudio has and Pyx lacked, each with Pyx's own twist:
//
//   - math preview on hover (TeXstudio / LaTeX Workshop), with every \py{}
//     inside the formula shown as its LIVE VALUE — the formula as it will be
//     printed, not as it is typed;
//   - Ctrl+click on a \ref{…} jumps to its \label (TeXstudio "Definition");
//   - renaming \begin{x} renames its matching \end{x} as you type, and the
//     other way round (latex-env.js knows which one matches);
//   - the last compile's errors and warnings underlined on their lines
//     (TeXstudio's log markers), F8 / Shift+F8 to walk them.

import { hoverTooltip, EditorView } from '@codemirror/view';
import { Prec } from '@codemirror/state';
import katex from 'katex';
import { findPyExprs } from '../compile/latex-bridge.js';
import { ghostValue } from './py-ghost.js';
import { gv } from '../solid/stores/settingsStore.js';
import { state as appState } from '../core/state.js';
import { t } from '../core/i18n.js';
import { matchingEnd, envRenameFilter } from './latex-env.js';

/* ---------------- where is the math? ---------------- */

const MATH_ENVS = 'equation|align|gather|multline|flalign|alignat|displaymath|math|eqnarray';
const ENV_RE = new RegExp(`\\\\begin\\s*\\{(${MATH_ENVS})(\\*?)\\}([\\s\\S]*?)\\\\end\\s*\\{\\1\\2\\}`, 'g');

/**
 * The formula around `pos` in `text`: { from, to, tex, display } or null.
 * Display environments and \[…\] / $$…$$ first (they can span lines), then
 * inline $…$ / \(…\) on the line itself. Pure, for testing.
 */
export function mathAt(text, pos) {
  const W = 6000;
  const a = Math.max(0, pos - W), b = Math.min(text.length, pos + W);
  const win = text.slice(a, b);
  const p = pos - a;
  ENV_RE.lastIndex = 0;
  let m;
  while ((m = ENV_RE.exec(win))) {
    if (m.index <= p && p <= m.index + m[0].length) {
      const env = m[1] === 'eqnarray' ? 'align' : m[1]; // KaTeX has no eqnarray
      return {
        from: a + m.index, to: a + m.index + m[0].length, display: true,
        tex: env === 'math' || env === 'displaymath' ? m[3] : `\\begin{${env}${m[2]}}${m[3]}\\end{${env}${m[2]}}`,
      };
    }
    if (m.index > p) break;
  }
  for (const [open, close] of [['\\[', '\\]'], ['$$', '$$']]) {
    const s = win.lastIndexOf(open, p);
    if (s < 0) continue;
    const e = win.indexOf(close, Math.max(s + open.length, p - close.length + 1));
    if (e >= 0 && s + open.length <= e && p <= e + close.length) {
      const inner = win.slice(s + open.length, e);
      if (open === '$$' || !inner.includes('\\]')) {
        return { from: a + s, to: a + e + close.length, tex: inner, display: true };
      }
    }
  }
  // Inline: the line holding pos, its unescaped $ paired left to right.
  const ls = text.lastIndexOf('\n', pos - 1) + 1;
  let le = text.indexOf('\n', pos);
  if (le < 0) le = text.length;
  const line = text.slice(ls, le);
  const c = pos - ls;
  let open = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\') {
      if (line[i + 1] === '(') { open = i; i++; continue; }
      if (line[i + 1] === ')' && open >= 0 && line[open] === '\\') {
        if (open <= c && c <= i + 2) return { from: ls + open, to: ls + i + 2, tex: line.slice(open + 2, i), display: false };
        open = -1; i++; continue;
      }
      i++; continue;
    }
    if (ch === '%') break;
    if (ch === '$' && line[i + 1] !== '$') {
      if (open < 0) open = i;
      else if (line[open] === '$') {
        if (open <= c && c <= i + 1) return { from: ls + open, to: ls + i + 1, tex: line.slice(open + 1, i), display: false };
        open = -1;
      }
    }
  }
  return null;
}

/** The formula as it will be printed: labels out, \py{} replaced by their
 *  live values (or a visible placeholder when there is none yet). */
export function printableTex(tex, valueOf = () => null) {
  let out = tex.replace(/\\label\s*\{[^}]*\}/g, '').replace(/\\(nonumber|notag)\b/g, '');
  const exprs = findPyExprs(out).sort((x, y) => y.start - x.start);
  for (const e of exprs) {
    const v = valueOf(e.expr);
    const shown = v != null
      ? String(v).replace(/^\\ensuremath\{([\s\S]*)\}$/, '$1')
      : `\\boxed{\\texttt{${e.expr.replace(/[{}\\#$%&_^~]/g, '')}}}`;
    out = out.slice(0, e.start) + `{${shown}}` + out.slice(e.end);
  }
  return out;
}

export const mathHover = hoverTooltip((view, pos) => {
  if (gv('mathHover') === false) return null;
  const m = mathAt(view.state.doc.toString(), pos);
  if (!m || !m.tex.trim()) return null;
  return {
    pos: m.from,
    end: m.to,
    above: true,
    create() {
      const dom = document.createElement('div');
      dom.className = 'cm-math-hover';
      try {
        dom.innerHTML = katex.renderToString(printableTex(m.tex, ghostValue), {
          displayMode: true, throwOnError: false, strict: false, trust: false, output: 'html',
        });
      } catch (_) {
        dom.textContent = m.tex;
      }
      return { dom };
    },
  };
}, { hoverTime: 300 });

/* ---------------- Ctrl+click on \ref → its \label ---------------- */

const REF_RE = /\\(?:ref|eqref|pageref|autoref|cref|Cref|nameref|vref|Vref|cpageref)\*?\s*\{([^}]*)\}/g;

/** The label key under `col` of `line`, if `col` sits inside a \ref{…}. */
export function refKeyAt(line, col) {
  REF_RE.lastIndex = 0;
  let m;
  while ((m = REF_RE.exec(line))) {
    const open = m.index + m[0].indexOf('{') + 1;
    if (col < m.index || col > m.index + m[0].length) continue;
    let off = open;
    for (const part of m[1].split(',')) {
      if (col >= off && col <= off + part.length) return part.trim() || null;
      off += part.length + 1;
    }
    return m[1].split(',')[0].trim() || null;
  }
  return null;
}

function jumpToLabel(view, key) {
  const want = `\\label{${key}}`;
  const text = view.state.doc.toString();
  const at = text.indexOf(want);
  if (at >= 0) {
    view.dispatch({ selection: { anchor: at + 7, head: at + 7 + key.length }, scrollIntoView: true });
    view.focus();
    return true;
  }
  // Another open file of the project (a chapter).
  for (const d of appState.documents) {
    if (d.kind || !d.path) continue;
    import('./setup.js').then(({ getDocContent }) => {
      const other = getDocContent(d.id) || '';
      const i = other.indexOf(want);
      if (i < 0) return;
      import('../solid/stores/docStore.js').then((ds) => ds.openPath(d.path)).then(() => {
        const ln = other.slice(0, i).split('\n').length;
        import('./commands.js').then((c) => c.gotoLineCol(ln, -1, key));
      });
    });
  }
  return false;
}

const refClicks = Prec.high(EditorView.domEventHandlers({
  mousedown(e, view) {
    if (e.button !== 0 || !e.ctrlKey) return false;
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    if (pos == null) return false;
    const line = view.state.doc.lineAt(pos);
    const key = refKeyAt(line.text, pos - line.from);
    if (!key) return false;
    e.preventDefault();
    jumpToLabel(view, key);
    return true;
  },
}));

/* ---------------- \begin{x} ↔ \end{x}: renaming one renames the other ---------------- */

export { matchingEnd };

// The filter itself lives in latex-env.js, with the rest of the environment
// logic; here it only reads the user's setting.
const renameEnv = envRenameFilter(() => gv('envRename') !== false);

/* ---------------- the last compile's problems, on their lines ---------------- */

let problemsOf = () => [];
/** Hook for the compile-log problems (EditorPane parses the log). */
export function setProblemsSource(fn) { problemsOf = fn; }

/** Diagnostics for the document `path` from the last compile's log. */
export function compileDiagnostics(view, path) {
  if (!path || gv('logMarkers') === false) return [];
  const base = path.split(/[\\/]/).pop().toLowerCase();
  const doc = view.state.doc;
  const out = [];
  for (const p of problemsOf() || []) {
    if (!p.line || !p.file) continue;
    if (String(p.file).split(/[\\/]/).pop().toLowerCase() !== base) continue;
    if (p.line > doc.lines) continue;
    const line = doc.line(p.line);
    out.push({
      from: line.from,
      to: Math.max(line.from + 1, line.to),
      severity: p.severity === 'error' ? 'error' : p.severity === 'warning' ? 'warning' : 'info',
      message: `${p.message} (${t('última compilación', 'last compile')})`,
      source: 'LaTeX',
    });
  }
  return out.filter((d) => d.to <= doc.length);
}

export const latexExtras = [mathHover, refClicks, renameEnv];
