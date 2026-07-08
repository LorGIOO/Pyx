// The LaTeX <-> Python bridge.
//
// In the document you reference Python values with \py{EXPR}, where EXPR is any
// Python expression evaluated in the kernel namespace built by the cells:
//
//     \py{areacirculo}            -> 78.5398
//     \py{areacirculo*2 - 3/2}    -> 155.58
//     \py{f"{areacirculo:.2f}"}   -> 78.54
//
// At compile time Calc finds every \py{...}, evaluates them in the kernel, and
// writes a build copy of the document with the results substituted in, which is
// what actually gets compiled.

// Path helpers live in core/paths.js; re-exported so compile-side callers can
// keep importing everything bridge-related from here.
export { dirOf, baseName, stemOf, joinPath } from '../core/paths.js';

/**
 * Find every \py{...} occurrence, matching balanced braces so f-strings like
 * \py{f"{x:.2f}"} work. Returns [{start, end, expr}] with [start,end) covering
 * the whole \py{...} token.
 */
export function findPyExprs(text) {
  const out = [];
  const needle = '\\py{';
  let i = 0;
  while (i < text.length) {
    const at = text.indexOf(needle, i);
    if (at === -1) break;
    let depth = 1;
    let j = at + needle.length;
    while (j < text.length && depth > 0) {
      const c = text[j];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      if (depth === 0) break;
      j++;
    }
    if (depth !== 0) break; // unbalanced; stop
    out.push({ start: at, end: j + 1, expr: text.slice(at + needle.length, j) });
    i = j + 1;
  }
  return out;
}

/** Read a balanced {…} group whose opening brace is at `openIdx`. Returns
 * {inner, end} (end = index just past the matching `}`) or null if unbalanced. */
function readGroup(text, openIdx) {
  let depth = 1;
  let j = openIdx + 1;
  while (j < text.length && depth > 0) {
    const c = text[j];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    if (depth === 0) break;
    j++;
  }
  if (depth !== 0) return null;
  return { inner: text.slice(openIdx + 1, j), end: j + 1 };
}

/**
 * Find every \pyif{cond}{then}{else} — document text that adapts to a calc
 * result. Returns [{start, end, cond, thenText, elseText}] with balanced braces
 * so the branches can hold \py{…}, \textcolor{…}{…}, whole paragraphs, etc.
 */
export function findPyIfExprs(text) {
  const out = [];
  const needle = '\\pyif{';
  let i = 0;
  while (i < text.length) {
    const at = text.indexOf(needle, i);
    if (at === -1) break;
    const g1 = readGroup(text, at + needle.length - 1); // -1 → points at the first '{'
    if (!g1) break;
    if (text[g1.end] !== '{') { i = at + needle.length; continue; }
    const g2 = readGroup(text, g1.end);
    if (!g2) break;
    if (text[g2.end] !== '{') { i = at + needle.length; continue; }
    const g3 = readGroup(text, g2.end);
    if (!g3) break;
    out.push({ start: at, end: g3.end, cond: g1.inner, thenText: g2.inner, elseText: g3.inner });
    i = g3.end;
  }
  return out;
}

// The kernel evaluates a \pyif condition as bool(cond) → "True"/"False".
export function pyifKey(cond) { return 'bool(' + cond + ')'; }

/** Every \pyif condition in the text, INCLUDING those nested inside branches. */
export function collectPyIfConds(text) {
  const conds = [];
  for (const e of findPyIfExprs(text)) {
    conds.push(e.cond);
    conds.push(...collectPyIfConds(e.thenText));
    conds.push(...collectPyIfConds(e.elseText));
  }
  return conds;
}

function resolvePyIfOnce(text, valueMap) {
  const ifs = findPyIfExprs(text);
  if (!ifs.length) return text;
  let out = '';
  let cursor = 0;
  for (const e of ifs) {
    out += text.slice(cursor, e.start);
    const v = valueMap[pyifKey(e.cond)];
    out += v && v.ok && v.value === 'True' ? e.thenText : e.elseText;
    cursor = e.end;
  }
  out += text.slice(cursor);
  return out;
}

/** Replace each \pyif{cond}{then}{else} with the branch its condition selects.
 * Iterates so a branch that itself contains a \pyif is resolved too. */
export function resolvePyIf(text, valueMap) {
  let prev = text;
  let out = resolvePyIfOnce(prev, valueMap);
  let guard = 0;
  while (out !== prev && guard++ < 20) { prev = out; out = resolvePyIfOnce(prev, valueMap); }
  return out;
}

/** Replace each \py{expr} with its evaluated value from `valueMap`. */
export function resolvePyText(text, valueMap) {
  const exprs = findPyExprs(text);
  if (!exprs.length) return text;
  let out = '';
  let cursor = 0;
  for (const e of exprs) {
    out += text.slice(cursor, e.start);
    const v = valueMap[e.expr];
    out += v && v.ok ? v.value : '??';
    cursor = e.end;
  }
  out += text.slice(cursor);
  return out;
}

/**
 * Prepare the %#python … %#end blocks for the LaTeX engine.
 *
 * - A normal cell's Python is commented out (prefixed with %) so it isn't
 *   typeset — its values reach the document only through \py{...}.
 * - A handcalcs cell (one using %%render / %%tex) is REPLACED in place by the
 *   LaTeX that handcalcs produced, so the calculation is typeset automatically
 *   exactly where the cell sits. `renderByCode` maps a cell's raw code (the
 *   text between the markers, joined by "\n") to that LaTeX.
 *
 * For normal cells the line count is preserved (we prefix with %, not delete).
 */
export function neutralizeCells(text, renderByCode = {}) {
  const hasRenders = renderByCode && Object.keys(renderByCode).length > 0;
  const lines = text.split(/\r?\n/);
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim().startsWith('%#python')) {
      const open = i;
      const code = [];
      let j = i + 1;
      while (j < lines.length && !lines[j].trim().startsWith('%#end')) { code.push(lines[j]); j++; }
      const latex = hasRenders ? renderByCode[code.join('\n')] : undefined;
      if (latex != null) {
        out.push(latex); // handcalcs cell: typeset its LaTeX where the cell is
      } else {
        out.push(lines[open]);              // %#python (already a LaTeX comment)
        for (const c of code) out.push('%' + c);
        if (j < lines.length) out.push(lines[j]); // %#end
      }
      i = j < lines.length ? j + 1 : j;
    } else {
      out.push(lines[i]);
      i++;
    }
  }
  return out.join('\n');
}

export const BUILD_SUFFIX = '.build.tex';
