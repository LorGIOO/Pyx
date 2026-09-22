// Masking non-prose out of a LaTeX line, so the spell checker only ever sees
// text a human wrote for a human to read.
//
// This lives apart from `spellcheck.js` on purpose: it is pure string work with
// no CodeMirror, no DOM and no dictionary, which is what lets it be tested
// directly — and these rules are subtle enough that they need to be. The same
// split exists between `cells.js` and `cell-parse.js`, for the same reason.

// Word = a run of letters (incl. accents); checked only when it has >= 2
// letters, isn't ALL-CAPS (acronym) and has no digits.
export const WORD = /\p{L}[\p{L}\p{M}]*/gu;
export const isAcronym = (w) => w === w.toUpperCase() && w.length <= 6;

// Commands whose {argument} is NOT prose (identifiers, keys, paths, code).
//
// Two rules keep this honest, and both were bugs once:
//  1. The alternation is first-match-wins, so a name that is a PREFIX of another
//     has to come after it: with `include` first, `\includegraphics{fig/viga}`
//     matched only `\include` and left "graphics" behind to be spell-checked —
//     a red squiggle under every figure of a real document.
//  2. The `(?![a-zA-Z])` after the group forces the command name to END there,
//     so an unlisted `\reflectbox{...}` can never be eaten as `\ref` plus
//     leftovers. Alternation backtracks into the longer branch when the
//     lookahead fails, so the two rules reinforce each other.
export const NOPROSE = new RegExp(
  '\\\\(?:' +
  'includegraphics|includepdf|include|input|' +
  'ref|eqref|pageref|autoref|nameref|cref|Cref|label|cite[a-zA-Z]*|' +
  'usepackage|documentclass|' +
  'bibliographystyle|bibliography|addbibresource|url|href|hyperref|' +
  'begin|end|pyfile|py|textcolor|definecolor|color|thispagestyle|pagestyle|' +
  'renewcommand|providecommand|newcommand|def|let|graphicspath|geometry|' +
  'setlength|setcounter|usetikzlibrary|lstinputlisting|lstset|verb' +
  ')(?![a-zA-Z])\\*?\\s*(?:\\[[^\\]]*\\])?\\s*(?:\\{[^{}]*\\})?',
  'g',
);

// Replace a slice with spaces so character offsets stay aligned with the line.
function blank(s, re) {
  return s.replace(re, (m) => ' '.repeat(m.length));
}

// Mask one line's non-prose so the leftover is pure text at the same offsets.
// Every rule blanks in place — never shortens — because the caller maps the
// surviving words back onto the real document by their column.
export function maskLine(text) {
  let t = text;
  // Comment: from an unescaped % to end of line.
  const cm = t.replace(/\\%/g, '  ').indexOf('%');
  if (cm >= 0) t = t.slice(0, cm) + ' '.repeat(t.length - cm);
  t = blank(t, /\\\([^)]*?\\\)/g);         // inline math \(…\)
  t = blank(t, /\\verb\*?(.).*?\1/g);      // inline verbatim \verb|…|
  t = blank(t, /\$[^$]*\$/g);              // inline math $…$
  t = blank(t, NOPROSE);                   // \ref{…}, \cite{…}, \py{…}, …
  t = blank(t, /\\[a-zA-Z@]+\*?/g);        // remaining command NAMES
  t = blank(t, /\[[^\[\]]*\]/g);           // optional args / options: [on] [draft] [key=val]
  t = blank(t, /\\[^a-zA-Z]/g);            // \%, \&, \\, \_ …
  return t;
}
