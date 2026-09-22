// LaTeX highlighting that reproduces TeXstudio's factory scheme.
//
// The palette is not an invention: it comes from the two XML files TeXstudio
// ships and loads at startup — utilities/qxs/defaultFormats.qxf (light) and
// defaultFormatsDark.qxf (dark) — cross-checked against the format scheme a
// real TeXstudio install writes into its own texstudio.ini. Each CSS class
// below is named after the TeXstudio format id it stands for, so the mapping
// stays auditable.
//
// Three facts about TeXstudio surprise everyone and drive the design here:
//
//   * The format called `numbers` is the MATH BODY color. Digits in ordinary
//     text get no color at all — TeXstudio has no rule for them.
//   * Braces, brackets and `\%`-style escapes have no color of their own
//     either: escapes are painted with the plain `keyword` color, and braces
//     are only highlighted transiently under the cursor.
//   * `\begin`/`\end` and the sectioning commands share one format
//     (`extra-keyword`, bold); the environment NAME gets its own on top, and
//     the TITLE inside `\section{…}` gets `structure` (bold).
//
// Everything is viewport-only for speed; cell lines are skipped (the Python
// overlay owns them). Multi-line constructs (display math, verbatim bodies,
// tikz pictures) need the state at the top of the viewport, which is obtained
// by scanning a bounded number of lines backwards — see BACKSCAN.

import { Decoration, ViewPlugin } from '@codemirror/view';
import { parseCells, cellAtLine } from './cell-parse.js';

/* ---------- vocabulary ---------- */

// `extra-keyword` in TeXstudio: the sectioning commands (populated at runtime
// from the loaded .cwl files; this is the LaTeX kernel + KOMA set).
const SECTION = /^(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph|addpart|addchap|addsec|frametitle)\*?$/;

// Commands whose ARGUMENT TeXstudio paints green (reference / citation /
// package "present" formats). We do not resolve the target, so the argument
// always gets the "present" color, which is what a well-formed document shows.
const REF_CMDS = new Set(['ref', 'pageref', 'eqref', 'autoref', 'nameref', 'vref', 'cref',
  'Cref', 'labelcref']);
const CITE_CMDS = new Set(['cite', 'citep', 'citet', 'citeauthor', 'citeyear', 'parencite',
  'textcite', 'footcite', 'nocite']);
const PKG_CMDS = new Set(['usepackage', 'RequirePackage', 'documentclass', 'usetheme',
  'LoadClass', 'usetikzlibrary']);
const TODO_CMDS = new Set(['todo', 'missingfigure', 'listoftodos']);

// Environments whose body TeXstudio paints with `verbatim` / `picture`.
const VERBATIM_ENVS = new Set(['verbatim', 'Verbatim', 'BVerbatim', 'LVerbatim', 'lstlisting',
  'minted', 'alltt', 'comment', 'filecontents', 'filecontents*', 'verbatim*', 'lstlisting*',
  'pyconcode', 'sagesilent', 'asy']);
const PICTURE_ENVS = new Set(['tikzpicture', 'picture', 'pgfpicture', 'pspicture',
  'tikzcd', 'circuitikz']);
// Environments whose body is math (TeXstudio colors it with `numbers`).
const MATH_ENVS = new Set(['equation', 'equation*', 'align', 'align*', 'alignat', 'alignat*',
  'gather', 'gather*', 'multline', 'multline*', 'flalign', 'flalign*', 'eqnarray', 'eqnarray*',
  'displaymath', 'math', 'dmath', 'dmath*', 'IEEEeqnarray', 'IEEEeqnarray*']);

// Magic comments: `% !TeX …`, `%&format`, `% BEGIN_FOLD`.
const MAGIC_COMMENT = /^%\s*(?:!\s*(?:TeX|BIB)\b|&|(?:BEGIN|END)_FOLD\b)/i;
// TeXstudio's default "todo comment" regex (configmanager.cpp).
const TODO_COMMENT = /^%\s*(?:TODO|todo|FIXME|fixme)\b/;

// How far back we are willing to look for the environment/math context of the
// first visible line. Display math and verbatim blocks longer than this are
// vanishingly rare, and the bound is what keeps a 30 MB document typable.
const BACKSCAN = 400;

/* ---------- per-line state machine ---------- */

const freshState = () => ({ verb: null, pict: null, math: null, inline: 0, display: false });

const TOKEN = /\\(?:\[|\]|\(|\))|\\([a-zA-Z@]+\*?)|\\(.)|(%)|(\$\$|\$)|(&)/g;

/**
 * Walk one line, appending marks and returning the state for the next line.
 * `push` is `(from, to, cls)` with offsets relative to the line start.
 */
function scanLine(text, st, push) {
  // Inside a verbatim body nothing is LaTeX until the matching \end.
  if (st.verb) {
    const end = text.match(new RegExp('\\\\end\\s*\\{' + esc(st.verb) + '\\}'));
    if (!end) { if (text.length) push(0, text.length, 'cm-lx-verbatim'); return st; }
    if (end.index > 0) push(0, end.index, 'cm-lx-verbatim');
    markEnvCommand(text, end.index, end.index + end[0].length, push);
    const rest = { ...st, verb: null };
    return scanRest(text, end.index + end[0].length, rest, push);
  }
  return scanRest(text, 0, st, push);
}

function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// `\begin{name}` / `\end{name}`: the command and braces are extra-keyword, the
// name gets the `environment` format on top.
function markEnvCommand(text, from, to, push) {
  const seg = text.slice(from, to);
  const m = seg.match(/^(\\(?:begin|end)\s*\{)([^}]*)(\})$/);
  if (!m) { push(from, to, 'cm-lx-envkw'); return; }
  push(from, from + m[1].length, 'cm-lx-envkw');
  if (m[2].length) push(from + m[1].length, from + m[1].length + m[2].length, 'cm-lx-envname');
  push(to - 1, to, 'cm-lx-envkw');
}

function scanRest(text, start, st, push) {
  const state = { ...st };
  let i = start;
  // Where the current math run began (so the body can be painted in one mark).
  let bodyFrom = inMath(state) ? start : -1;

  const flushBody = (upto) => {
    if (bodyFrom >= 0 && upto > bodyFrom) {
      push(bodyFrom, upto, state.pict ? 'cm-lx-picture' : 'cm-lx-mathbody');
    }
    bodyFrom = -1;
  };
  // Outside math, a tikz body is still painted (with `picture`).
  if (bodyFrom < 0 && state.pict) bodyFrom = start;

  TOKEN.lastIndex = start;
  let m;
  while ((m = TOKEN.exec(text))) {
    if (m.index < i) continue;
    const from = m.index;
    const to = TOKEN.lastIndex;

    // ---- % comment: runs to end of line, whatever the mode.
    if (m[3] != null) {
      flushBody(from);
      const rest = text.slice(from);
      const cls = MAGIC_COMMENT.test(rest) ? 'cm-lx-magic'
        : TODO_COMMENT.test(rest) ? 'cm-lx-todo' : 'cm-lx-comment';
      push(from, text.length, cls);
      return state;
    }

    // ---- \[ \] \( \): display / inline math delimiters.
    if (m[1] == null && m[2] == null && m[0].length === 2 && '[]()'.includes(m[0][1])) {
      const open = m[0][1] === '[' || m[0][1] === '(';
      flushBody(from);
      push(from, to, 'cm-lx-mathdelim');
      if (open) { state.display = state.display || m[0][1] === '['; if (m[0][1] === '(') state.inline++; }
      else if (m[0][1] === ']') state.display = false;
      else state.inline = Math.max(0, state.inline - 1);
      if (inMath(state) || state.pict) bodyFrom = to;
      i = to;
      continue;
    }

    // ---- $ / $$
    if (m[4] != null) {
      flushBody(from);
      push(from, to, 'cm-lx-mathdelim');
      if (m[4] === '$$') state.display = !state.display;
      else state.inline = state.inline ? 0 : 1;
      if (inMath(state) || state.pict) bodyFrom = to;
      i = to;
      continue;
    }

    // ---- & alignment separator (priority 5 in TeXstudio: it shows through math)
    if (m[5] != null) {
      const keep = bodyFrom;
      flushBody(from);
      push(from, to, 'cm-lx-amp');
      bodyFrom = keep >= 0 ? to : -1;
      i = to;
      continue;
    }

    // ---- \x escape (\%, \&, \\, \_ …): plain keyword color in TeXstudio.
    if (m[1] == null && m[2] != null) {
      const keep = bodyFrom;
      flushBody(from);
      push(from, to, inMath(state) ? 'cm-lx-mathcmd' : 'cm-lx-cmd');
      bodyFrom = keep >= 0 ? to : -1;
      i = to;
      continue;
    }

    // ---- \command
    const name = m[1];
    const bare = name.replace(/\*$/, '');
    const keepBody = bodyFrom;
    flushBody(from);

    if (bare === 'begin' || bare === 'end') {
      const after = text.slice(to);
      const env = after.match(/^\s*\{([^}]*)\}/);
      const stop = env ? to + env[0].length : to;
      markEnvCommand(text, from, stop, push);
      if (env) {
        const nm = env[1];
        if (bare === 'begin') {
          if (VERBATIM_ENVS.has(nm)) {
            state.verb = nm;
            // `egin{lstlisting}[language=Python]`: the option list is still
            // LaTeX, only what follows it is verbatim.
            const opt = text.slice(stop).match(/^\s*\[[^\]]*\]/);
            const body = stop + (opt ? opt[0].length : 0);
            if (body < text.length) push(body, text.length, 'cm-lx-verbatim');
            return state;
          }
          if (PICTURE_ENVS.has(nm)) state.pict = nm;
          else if (MATH_ENVS.has(nm)) state.math = nm;
        } else {
          if (state.pict === nm) state.pict = null;
          if (state.math === nm) state.math = null;
        }
      }
      TOKEN.lastIndex = stop;
      i = stop;
      bodyFrom = (inMath(state) || state.pict) ? stop : -1;
      continue;
    }

    // `\verb|…|`: whatever follows, up to the repeated delimiter, is verbatim.
    if (bare === 'verb') {
      push(from, to, 'cm-lx-cmd');
      const d = text[to];
      if (d) {
        const close = text.indexOf(d, to + 1);
        const stop = close < 0 ? text.length : close + 1;
        push(to, stop, 'cm-lx-verbatim');
        TOKEN.lastIndex = stop;
        i = stop;
      } else { i = to; }
      bodyFrom = keepBody >= 0 ? TOKEN.lastIndex : -1;
      continue;
    }

    // The Pyx bridge — not a TeXstudio format, an addition of this editor.
    if (bare === 'py') push(from, to, 'cm-lx-py');
    else if (SECTION.test(name)) push(from, to, 'cm-lx-section');
    else if (inMath(state)) push(from, to, 'cm-lx-mathcmd');
    else if (state.pict) push(from, to, 'cm-lx-picturekw');
    else push(from, to, 'cm-lx-cmd');

    // Arguments that get a color of their own.
    let stop = to;
    const arg = text.slice(to).match(/^\s*(\[[^\]]*\])?\s*\{([^{}]*)\}/);
    if (arg) {
      const argStart = to + arg[0].length - arg[2].length - 1;
      const cls = SECTION.test(name) ? 'cm-lx-structure'
        : REF_CMDS.has(bare) ? 'cm-lx-ref'
          : CITE_CMDS.has(bare) ? 'cm-lx-cite'
            : PKG_CMDS.has(bare) ? 'cm-lx-package'
              : TODO_CMDS.has(bare) ? 'cm-lx-todo' : null;
      if (cls && arg[2].length) {
        push(argStart, argStart + arg[2].length, cls);
        stop = to + arg[0].length;
        TOKEN.lastIndex = stop;
      }
    }
    i = stop;
    bodyFrom = keepBody >= 0 ? stop : -1;
  }
  flushBody(text.length);
  // `$…$` does not survive a blank line in TeX; neither does it here, which
  // keeps one stray `$` from tinting the rest of the document.
  if (!text.trim()) state.inline = 0;
  return state;
}

function inMath(st) { return !!st.math || st.display || st.inline > 0; }

/* ---------- view plugin ---------- */

function buildLatexDeco(view) {
  const state = view.state;
  const doc = state.doc;
  const ranges = [];
  const cells = parseCells(state);
  const inCell = (ln) => cellAtLine(cells, ln) !== null;

  for (const vr of view.visibleRanges) {
    const firstLn = doc.lineAt(vr.from).number;
    const lastLn = doc.lineAt(vr.to).number;

    // Recover the multi-line context (verbatim / display math / picture) by
    // replaying a bounded window of earlier lines with the marks discarded.
    let st = freshState();
    const back = Math.max(1, firstLn - BACKSCAN);
    const noop = () => {};
    for (let ln = back; ln < firstLn; ln++) {
      if (inCell(ln)) continue;
      st = scanLine(doc.line(ln).text, st, noop);
    }

    for (let ln = firstLn; ln <= lastLn; ln++) {
      if (inCell(ln)) continue;
      const line = doc.line(ln);
      if (!line.text) { st = scanLine('', st, () => {}); continue; }
      const base = line.from;
      st = scanLine(line.text, st, (f, t, cls) => {
        if (t > f) ranges.push(Decoration.mark({ class: cls }).range(base + f, base + t));
      });
    }
  }
  ranges.sort((a, b) => a.from - b.from || b.to - a.to);
  return Decoration.set(ranges, true);
}

export const latexHighlight = ViewPlugin.fromClass(
  class {
    constructor(view) { this.decorations = safeBuild(view); }
    update(u) {
      if (u.docChanged || u.viewportChanged) this.decorations = safeBuild(u.view);
    }
  },
  { decorations: (v) => v.decorations }
);

function safeBuild(view) {
  try {
    return buildLatexDeco(view);
  } catch (_) {
    return Decoration.none; // a syntax overlay must never take the editor down
  }
}

// Exported for the tests: classify one standalone chunk of LaTeX.
export function classifyLatex(text) {
  let st = freshState();
  const out = [];
  let at = 0;
  for (const line of text.split('\n')) {
    const base = at;
    st = scanLine(line, st, (f, t, cls) => { if (t > f) out.push({ from: base + f, to: base + t, cls }); });
    at += line.length + 1;
  }
  out.sort((a, b) => a.from - b.from || b.to - a.to);
  return out;
}
