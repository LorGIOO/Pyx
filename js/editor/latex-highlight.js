// Granular LaTeX highlighting overlay (TeXstudio-grade): every construct gets
// its own themed color — sectioning, \begin/\end + environment names,
// preamble, refs/labels, text formatting, math commands, $math$ regions
// (background tint), [options], braces, numbers+units, table separators and
// the \py{} Python bridge. Viewport-only for speed; cell lines are skipped
// (the Python overlay owns them).

import { Decoration, ViewPlugin } from '@codemirror/view';
import { parseCells } from './cells.js';

const SECTION = /^(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?$/;
const PREAMBLE = new Set(['documentclass', 'usepackage', 'RequirePackage', 'input', 'include',
  'subfile', 'import', 'newcommand', 'renewcommand', 'newenvironment', 'definecolor',
  'geometry', 'pagestyle', 'bibliographystyle', 'graphicspath']);
const REFS = new Set(['label', 'ref', 'eqref', 'pageref', 'autoref', 'nameref', 'cite', 'citep',
  'citet', 'footnote', 'bibliography', 'index']);
const URLS = new Set(['url', 'href', 'hyperref']);
const TEXTFMT = new Set(['textbf', 'textit', 'emph', 'underline', 'texttt', 'textsc', 'textsf',
  'textrm', 'textcolor', 'textsuperscript', 'textsubscript', 'uppercase', 'mathbf', 'mathrm',
  'mathit', 'mathcal', 'mathbb', 'mathfrak', 'mathsf', 'mathtt', 'boldmath', 'small', 'large',
  'Large', 'LARGE', 'huge', 'Huge', 'tiny', 'scriptsize', 'footnotesize', 'normalsize']);
const MATHCMD = new Set(['frac', 'dfrac', 'tfrac', 'sqrt', 'sum', 'prod', 'int', 'iint', 'oint',
  'lim', 'infty', 'partial', 'nabla', 'cdot', 'times', 'div', 'pm', 'mp', 'leq', 'geq', 'neq',
  'approx', 'equiv', 'sim', 'propto', 'rightarrow', 'leftarrow', 'Rightarrow', 'Leftarrow',
  'left', 'right', 'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'varepsilon', 'zeta', 'eta',
  'theta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'pi', 'rho', 'sigma', 'tau', 'upsilon',
  'phi', 'varphi', 'chi', 'psi', 'omega', 'Gamma', 'Delta', 'Theta', 'Lambda', 'Xi', 'Pi',
  'Sigma', 'Upsilon', 'Phi', 'Psi', 'Omega', 'sin', 'cos', 'tan', 'log', 'ln', 'exp', 'min',
  'max', 'hat', 'bar', 'vec', 'dot', 'ddot', 'tilde', 'overline', 'underline', 'overbrace',
  'underbrace', 'binom', 'langle', 'rangle', 'lfloor', 'rfloor', 'lceil', 'rceil', 'forall',
  'exists', 'in', 'notin', 'subset', 'supset', 'cup', 'cap', 'setminus', 'mathbb']);

function cmdClass(name) {
  const bare = name.replace(/\*$/, '');
  if (bare === 'py') return 'cm-lx-py';
  if (bare === 'begin' || bare === 'end') return 'cm-lx-envkw';
  if (SECTION.test(name)) return 'cm-lx-section';
  if (PREAMBLE.has(bare)) return 'cm-lx-preamble';
  if (URLS.has(bare)) return 'cm-lx-url';
  if (REFS.has(bare)) return 'cm-lx-ref';
  if (TEXTFMT.has(bare)) return 'cm-lx-textfmt';
  if (MATHCMD.has(bare)) return 'cm-lx-mathcmd';
  return 'cm-lx-cmd';
}

const TOKEN = /\\([a-zA-Z@]+\*?)|\\[\\\[\]$%&#_{}~^,;: ]|(%)|(\$)|([{}])|([\[\]])|(\d+(?:\.\d+)?(?:pt|mm|cm|em|ex|in|bp)?)|(&)/g;

function buildLatexDeco(view) {
  const state = view.state;
  const doc = state.doc;
  const ranges = [];

  // Lines covered by Python cells (skipped here).
  const cellLines = [];
  for (const c of parseCells(state)) cellLines.push([c.headerLine, c.endLine]);
  const inCell = (ln) => cellLines.some(([a, b]) => ln >= a && ln <= b);

  for (const vr of view.visibleRanges) {
    let ln = doc.lineAt(vr.from).number;
    const lastLn = doc.lineAt(vr.to).number;
    for (; ln <= lastLn; ln++) {
      if (inCell(ln)) continue;
      const line = doc.line(ln);
      const text = line.text;
      if (!text) continue;

      let mathOpen = -1; // pos after an opening $
      TOKEN.lastIndex = 0;
      let m;
      while ((m = TOKEN.exec(text))) {
        const from = line.from + m.index;
        const to = line.from + TOKEN.lastIndex;

        // % comment (escaped \% is consumed by the escape alternative).
        if (m[2] != null) {
          ranges.push(Decoration.mark({ class: 'cm-lx-comment' }).range(from, line.to));
          mathOpen = -1;
          break;
        }

        // Escape sequence (\%, \&, \\, \_…): TeXstudio's "escaparsiguiente".
        if (m[1] == null && m[0][0] === '\\') {
          ranges.push(Decoration.mark({ class: 'cm-lx-escape' }).range(from, to));
          continue;
        }

        if (m[1] != null) { // \command
          const cls = cmdClass(m[1]);
          ranges.push(Decoration.mark({ class: cls }).range(from, to));
          // \begin{name} / \end{name}: color the environment name distinctly.
          if (cls === 'cm-lx-envkw') {
            const rest = text.slice(TOKEN.lastIndex);
            const env = rest.match(/^\{([^}]*)\}/);
            if (env) {
              const s = line.from + TOKEN.lastIndex;
              ranges.push(Decoration.mark({ class: 'cm-lx-brace' }).range(s, s + 1));
              if (env[1].length) {
                ranges.push(Decoration.mark({ class: 'cm-lx-envname' }).range(s + 1, s + 1 + env[1].length));
              }
              ranges.push(Decoration.mark({ class: 'cm-lx-brace' }).range(s + env[0].length - 1, s + env[0].length));
              TOKEN.lastIndex += env[0].length;
            }
          }
        } else if (m[3] != null) { // $ math toggle
          ranges.push(Decoration.mark({ class: 'cm-lx-mathdelim' }).range(from, to));
          if (mathOpen < 0) {
            mathOpen = to;
          } else {
            if (from > mathOpen) {
              ranges.push(Decoration.mark({ class: 'cm-lx-math' }).range(mathOpen, from));
            }
            mathOpen = -1;
          }
        } else if (m[4] != null) { // { }
          ranges.push(Decoration.mark({ class: 'cm-lx-brace' }).range(from, to));
        } else if (m[5] != null) { // [ ]
          ranges.push(Decoration.mark({ class: 'cm-lx-opt' }).range(from, to));
        } else if (m[6] != null) { // number (+unit)
          ranges.push(Decoration.mark({ class: 'cm-lx-number' }).range(from, to));
        } else if (m[7] != null) { // & column separator
          ranges.push(Decoration.mark({ class: 'cm-lx-amp' }).range(from, to));
        }
      }
      // Unclosed $ on this line: tint to end of line.
      if (mathOpen >= 0 && line.to > mathOpen) {
        ranges.push(Decoration.mark({ class: 'cm-lx-math' }).range(mathOpen, line.to));
      }
    }
  }
  return Decoration.set(ranges, true);
}

export const latexHighlight = ViewPlugin.fromClass(
  class {
    constructor(view) { this.decorations = buildLatexDeco(view); }
    update(u) {
      if (u.docChanged || u.viewportChanged) this.decorations = buildLatexDeco(u.view);
    }
  },
  { decorations: (v) => v.decorations }
);
