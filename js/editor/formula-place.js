// Where a recognized formula lands in the document — pure functions (no DOM,
// no editor), unit-tested. Used by img-latex.js.

/* ---------- where the formula lands (pure: unit-tested) ---------- */

const MATH_ENV = /\\(begin|end)\s*\{(equation|align|alignat|flalign|gather|multline|eqnarray|displaymath|math|split|aligned|gathered|cases|array|[pbBvV]?matrix|smallmatrix|subequations)\*?\}/g;

/** Is position `pos` of `text` inside mathematics? Reads the text before it:
 *  an open math environment, an open \[ or \(, or an odd number of `$` in
 *  the paragraph. Comments and `\$` do not count. */
export function inMath(text, pos) {
  // Only the paragraph matters for $, but an environment can open far above:
  // look at a generous window before the caret.
  const before = String(text).slice(Math.max(0, pos - 20000), pos).replace(/(^|[^\\])%.*$/gm, '$1');
  let depth = 0;
  MATH_ENV.lastIndex = 0;
  let m;
  while ((m = MATH_ENV.exec(before))) depth += m[1] === 'begin' ? 1 : -1;
  if (depth > 0) return true;
  const last = (open, close) => before.lastIndexOf(open) > before.lastIndexOf(close);
  if (last('\\[', '\\]') || last('\\(', '\\)')) return true;
  // The paragraph: the lines since the last blank one.
  const lines = before.split('\n');
  let k = lines.length - 1;
  while (k >= 0 && lines[k].trim() !== '') k--;
  const para = lines.slice(k + 1).join('\n');
  let dollars = 0;
  for (let i = 0; i < para.length; i++) {
    if (para[i] === '\\') { i++; continue; }
    if (para[i] === '$') dollars++;
  }
  return dollars % 2 === 1;
}

/** The text to insert for a recognized formula. Inside mathematics it goes
 *  in as it is; outside, as a display (`\[ … \]` on its own lines) or inline
 *  (`$…$`), as Configuración says. `lineStart` = the caret is at the start
 *  of an empty line (no line break needed before a display). */
export function formulaInsert(latex, { math = false, mode = 'display', lineStart = true } = {}) {
  const body = String(latex).trim()
    // The recognizer sometimes wraps its answer; one wrapper is enough.
    .replace(/^\$\$([\s\S]*)\$\$$/, '$1').replace(/^\\\[([\s\S]*)\\\]$/, '$1').replace(/^\$([\s\S]*)\$$/, '$1').trim();
  if (math || mode === 'raw') return body;
  if (mode === 'inline') return `$${body}$`;
  return `${lineStart ? '' : '\n'}\\[\n  ${body}\n\\]\n`;
}
