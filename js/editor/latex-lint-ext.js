// The editor side of latex-lint.js (kept apart so the rules stay a pure,
// testable function).

import { linter } from '@codemirror/lint';
import { state as appState } from '../core/state.js';
import { gv } from '../solid/stores/settingsStore.js';
import { t } from '../core/i18n.js';
import { lintLatex } from './latex-lint.js';
import { compileDiagnostics } from './latex-extras.js';
import { invoke, isTauri } from '../core/platform.js';

/** LaTeX rules apply to LaTeX: a .bib, a .sty or a .txt is not a document. */
function isLatexDoc(docId) {
  const d = appState.documents.find((x) => x.id === docId);
  const name = (d && (d.fileName || d.path)) || '';
  return !name || /\.(tex|pltx)$/i.test(name) || !/\.[a-z0-9]+$/i.test(name);
}

/** The text ChkTeX should see: Python cells blanked out (their lines kept,
 *  so every line number still matches the editor). */
function latexOnly(text) {
  let inCell = false;
  return text.split('\n').map((l) => {
    const tr = l.trim();
    if (inCell) {
      if (tr.startsWith('%#end')) inCell = false;
      return '';
    }
    if (tr.startsWith('%#python')) { inCell = true; return ''; }
    return l;
  }).join('\n');
}

const CHK_SEVERITY = { Error: 'error', Warning: 'warning', Message: 'info' };

/** ChkTeX's style warnings (opt-in): what texlab adds on top of its own. */
async function chktexDiagnostics(view) {
  if (gv('chktex') !== true || !isTauri()) return [];
  const doc = view.state.doc;
  let hits;
  try {
    hits = await invoke('chktex_lint', { text: latexOnly(doc.toString()) });
  } catch (_) {
    return []; // not installed: the setting's hint says it needs ChkTeX
  }
  if (view.state.doc !== doc) return []; // the text moved on meanwhile
  const out = [];
  for (const h of hits || []) {
    if (h.line < 1 || h.line > doc.lines) continue;
    const line = doc.line(h.line);
    const from = Math.min(line.to, line.from + Math.max(0, h.column - 1));
    const to = Math.min(line.to, from + Math.max(1, h.length));
    if (to <= from) continue;
    out.push({
      from, to,
      severity: CHK_SEVERITY[h.kind] || 'info',
      message: `${h.message} (ChkTeX ${h.code})`,
      source: 'ChkTeX',
    });
  }
  return out;
}

/** CodeMirror extension: the diagnostics above, underlined as you type. */
export function latexLint(docId) {
  return linter(async (view) => {
    if (!isLatexDoc(docId)) return [];
    const own = gv('latexLint') === false ? [] : lintLatex(view.state.doc.toString(), t)
      .map((d) => ({ from: d.from, to: Math.min(d.to, view.state.doc.length), severity: d.severity, message: d.message, source: 'LaTeX' }))
      .filter((d) => d.from < d.to);
    const d = appState.documents.find((x) => x.id === docId);
    return own.concat(compileDiagnostics(view, d && d.path), await chktexDiagnostics(view));
  }, { delay: 500 });
}
