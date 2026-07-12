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

/* ---------------- verbatim awareness (minted, verbatim, \verb…) -----------
   Inside a verbatim environment the document is SHOWING code, not using it:
   `%#python` markers must not become cells and `\py{…}` must not be evaluated
   — everything stays plain text, exactly as TeXstudio treats verbatim. */
const VERBATIM_ENVS = new Set([
  'verbatim', 'Verbatim', 'BVerbatim', 'LVerbatim', 'lstlisting', 'minted',
  'alltt', 'comment', 'filecontents',
]);
const reBeginVerb = /\\begin\s*\{([A-Za-z]+)\*?\}/;
const reEndVerb = /\\end\s*\{([A-Za-z]+)\*?\}/;

/** Line-by-line tracker: call with each line IN ORDER; returns true while the
 * line belongs to a verbatim environment (\begin and \end lines included).
 * Once inside, only the matching \end{env} closes it (verbatim semantics). */
export function createVerbatimTracker() {
  let env = null;
  return (line) => {
    if (env) {
      const m = line.match(reEndVerb);
      if (m && m[1] === env) env = null;
      return true;
    }
    const b = line.match(reBeginVerb);
    if (b && VERBATIM_ENVS.has(b[1])) { env = b[1]; return true; }
    return false;
  };
}

/** Character ranges of text that must NOT be interpreted: lines inside
 * verbatim environments plus inline \verb|…| / \verb*|…| spans. */
export function protectedRanges(text) {
  const ranges = [];
  const inVerb = createVerbatimTracker();
  let pos = 0;
  for (const line of text.split('\n')) {
    const end = pos + line.length;
    if (inVerb(line)) {
      ranges.push([pos, end]);
    } else {
      const re = /\\verb\*?([^A-Za-z\s])/g;
      let m;
      while ((m = re.exec(line))) {
        const close = line.indexOf(m[1], re.lastIndex);
        const stop = close === -1 ? line.length : close + 1;
        ranges.push([pos + m.index, pos + stop]);
        re.lastIndex = stop;
      }
    }
    pos = end + 1;
  }
  return ranges;
}
const inRanges = (ranges, i) => ranges.some(([a, b]) => i >= a && i < b);

/**
 * Find every \py{...} occurrence, matching balanced braces so f-strings like
 * \py{f"{x:.2f}"} work. Returns [{start, end, expr}] with [start,end) covering
 * the whole \py{...} token. Occurrences inside verbatim contexts (minted,
 * verbatim, \verb…) are literal text and are NOT returned.
 */
export function findPyExprs(text) {
  const out = [];
  const needle = '\\py{';
  const skip = protectedRanges(text);
  let i = 0;
  while (i < text.length) {
    const at = text.indexOf(needle, i);
    if (at === -1) break;
    if (inRanges(skip, at)) { i = at + needle.length; continue; }
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
  const skip = protectedRanges(text);
  let i = 0;
  while (i < text.length) {
    const at = text.indexOf(needle, i);
    if (at === -1) break;
    if (inRanges(skip, at)) { i = at + needle.length; continue; }
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

/**
 * \py*{expr} — the ESCAPED form: shows the literal text "\py{expr}" in the
 * document instead of evaluating it (like \% shows a %). At build time it
 * becomes \texttt{\detokenize{\py{expr}}}, which typesets verbatim-safe.
 * Inside verbatim contexts it is left untouched (already literal there).
 */
function escapePyStar(text) {
  const needle = '\\py*{';
  if (!text.includes(needle)) return text;
  const skip = protectedRanges(text);
  let out = '';
  let cursor = 0;
  let i = 0;
  while (i < text.length) {
    const at = text.indexOf(needle, i);
    if (at === -1) break;
    if (inRanges(skip, at)) { i = at + needle.length; continue; }
    const g = readGroup(text, at + needle.length - 1);
    if (!g) break;
    out += text.slice(cursor, at) + '\\texttt{\\detokenize{\\py{' + g.inner + '}}}';
    cursor = g.end;
    i = g.end;
  }
  out += text.slice(cursor);
  return out;
}

/** Replace each \py{expr} with its evaluated value from `valueMap`, and each
 * escaped \py*{expr} with typeset-able literal text. */
export function resolvePyText(text, valueMap) {
  const exprs = findPyExprs(text);
  let out = text;
  if (exprs.length) {
    out = '';
    let cursor = 0;
    for (const e of exprs) {
      out += text.slice(cursor, e.start);
      const v = valueMap[e.expr];
      out += v && v.ok ? v.value : '??';
      cursor = e.end;
    }
    out += text.slice(cursor);
  }
  return escapePyStar(out);
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
  const inVerb = createVerbatimTracker();
  let i = 0;
  while (i < lines.length) {
    // Inside minted/verbatim the markers are DISPLAYED code, not a cell:
    // pass the line through untouched (the engine typesets it as-is).
    if (inVerb(lines[i])) {
      out.push(lines[i]);
      i++;
      continue;
    }
    if (lines[i].trim().startsWith('%#python')) {
      const open = i;
      const code = [];
      let j = i + 1;
      while (j < lines.length && !lines[j].trim().startsWith('%#end')) { code.push(lines[j]); j++; }
      const latex = hasRenders ? renderByCode[code.join('\n')] : undefined;
      if (latex != null) {
        // Handcalcs cell: typeset its LaTeX where the cell is — with ZERO line
        // shift. Newlines inside display math are just spaces, so the render
        // collapses to one line and the rest pads as % comments; SyncTeX and
        // log line numbers below the cell stay exact.
        out.push(latex.replace(/\s*\r?\n\s*/g, ' ').trim());
        const consumed = j < lines.length ? j - open + 1 : lines.length - open;
        for (let k = 1; k < consumed; k++) out.push('%');
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
