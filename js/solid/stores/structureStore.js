// Reactive view of the active document, plus the parsers that drive the side
// panel (TOC = sectioning tree; Estructura = \input/\include relations), the
// breadcrumbs and the status-bar word count.
//
// PERFORMANCE CONTRACT — read before changing anything here.
//
// The signal carries CodeMirror's immutable `Text` object, NEVER a materialized
// string. A thousand-page document is tens of megabytes: calling `.toString()`
// on every keystroke allocated (and then garbage-collected) the whole document
// each time, which is what made huge files unusable. Every parser below streams
// the document line by line via `iterLines()` — no full-document string, no
// giant intermediate copies, one linear pass each.
//
// The word count is the one genuinely expensive pass, so it does not run
// synchronously with typing: it is scheduled on idle time and chunked, and it
// publishes into its own signal.

import { createSignal } from 'solid-js';

/** The active document's text as a CodeMirror `Text` (or a plain string in
 *  tests). Cheap to hold and to swap — it is a rope, not a copy. */
export const [docSnap, setDocSnap] = createSignal(null, { equals: false });

/** Line iterator over either a CodeMirror `Text` or a plain string. */
function* eachLine(src) {
  if (!src) return;
  if (typeof src === 'string') {
    for (const l of src.split(/\r?\n/)) yield l;
    return;
  }
  yield* src.iterLines();
}

/** Character length of a `Text` or string (used for the size guards). */
function srcLength(src) {
  if (!src) return 0;
  return typeof src === 'string' ? src.length : src.length;
}

const LEVEL = {
  part: 0, chapter: 1, section: 2, subsection: 3,
  subsubsection: 4, paragraph: 5, subparagraph: 6,
};

const HEAD_RE = /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)(\*?)\s*\{/;

/** Sectioning entries with their 1-based line number (for jump-to-line). */
export function parseTOC(src) {
  const out = [];
  let i = 0;
  for (const text of eachLine(src)) {
    i++;
    // Fast reject: the overwhelming majority of lines have no backslash at all,
    // so skip the regex entirely for them.
    if (text.indexOf('\\') < 0) continue;
    const m = text.match(HEAD_RE);
    if (!m) continue;
    const open = text.indexOf('{', m.index);
    let depth = 1, j = open + 1, title = '';
    while (j < text.length && depth > 0) {
      const c = text[j];
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) break; }
      title += c;
      j++;
    }
    out.push({
      level: LEVEL[m[1]], kind: m[1], star: m[2] === '*',
      title: title.trim() || '(sin título)', line: i,
    });
  }
  return out;
}

/** TODO entries (TeXstudio lists them in the structure): `% TODO …` comments
 * and \todo{…} commands, with their 1-based line. */
export function parseTodos(src) {
  const out = [];
  let i = 0;
  for (const text of eachLine(src)) {
    i++;
    // Cheap pre-filter: a TODO entry always needs a '%' or a '\'.
    if (text.indexOf('%') < 0 && text.indexOf('\\') < 0) continue;
    let m = text.match(/%\s*(TODO|FIXME)\b[:\s]*(.*)$/i);
    if (!m) {
      const c = text.match(/\\todo\s*(?:\[[^\]]*\])?\{([^}]*)\}/);
      if (c) m = [null, 'TODO', c[1]];
    }
    if (m) out.push({ tag: m[1].toUpperCase(), text: (m[2] || '').trim(), line: i });
  }
  return out;
}

/** The section path (breadcrumbs) that contains a given 1-based line. */
export function crumbPath(toc, line) {
  const path = [];
  for (const h of toc) {
    if (h.line > line) break;
    while (path.length && path[path.length - 1].level >= h.level) path.pop();
    path.push(h);
  }
  return path;
}

/** Files this document pulls in (its children in the project structure). */
export function parseIncludes(src) {
  const out = [];
  const re = /\\(input|include|subfile|import)\s*(?:\[[^\]]*\])?\{([^}]*)\}/g;
  for (const text of eachLine(src)) {
    if (text.indexOf('\\') < 0) continue;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      let target = m[2].trim();
      if (target && !/\.[a-z]+$/i.test(target)) target += '.tex';
      out.push({ cmd: m[1], target });
    }
  }
  return out;
}

/* ---------------- word count (streaming, idle-scheduled) ----------------
   TeXstudio-style: prose only — Python cells, comments, LaTeX commands, math
   and markup don't count.

   The old version joined the whole document into one string and ran six global
   regex replaces over it, allocating several document-sized strings on every
   keystroke. This version walks it line by line with a tiny state machine and
   allocates nothing bigger than a line, so a 40 MB project counts in one cheap
   linear pass instead of thrashing the heap. */

const CMD_RE = /\\[a-zA-Z@]+\*?/g;
const MARKUP_RE = /[{}[\]()~&_^\\]/g;
const INLINE_MATH_RE = /\$[^$]*\$/g;
const WORD_RE = /[\p{L}\p{M}\p{N}]+(?:[-'’][\p{L}\p{M}\p{N}]+)*/gu;

/** Count prose words in one already-stripped line. */
function countLineWords(s) {
  if (!s) return 0;
  s = s.replace(INLINE_MATH_RE, ' ');
  s = s.replace(CMD_RE, ' ');
  s = s.replace(MARKUP_RE, ' ');
  WORD_RE.lastIndex = 0;
  let n = 0;
  while (WORD_RE.exec(s)) n++;
  return n;
}

/** Strip the trailing `% comment` (an escaped \% is not a comment). */
function stripComment(raw) {
  const pct = raw.indexOf('%');
  if (pct < 0) return raw;
  for (let i = pct; i < raw.length; i++) {
    if (raw[i] === '%' && (i === 0 || raw[i - 1] !== '\\')) return raw.slice(0, i);
  }
  return raw;
}

/**
 * Streaming word count. Walks the document once, tracking whether we are inside
 * a Python cell or a display-math block, and counts words line by line.
 */
export function countWords(src) {
  let n = 0;
  let inCell = false;
  let inDisplay = false; // \[ … \]  or  $$ … $$
  for (const raw of eachLine(src)) {
    const t = raw.trim();
    if (!inCell && t.startsWith('%#python')) { inCell = true; continue; }
    if (inCell) { if (t.startsWith('%#end')) inCell = false; continue; }

    let s = stripComment(raw);
    if (!s) continue;

    // Display math spans lines: consume it without counting, and keep whatever
    // prose sits before the opener / after the closer on the same line.
    while (s) {
      if (inDisplay) {
        const close = s.search(/\\\]|\$\$/);
        if (close < 0) { s = ''; break; }
        s = s.slice(close + 2); // both "\]" and "$$" are two characters
        inDisplay = false;
        continue;
      }
      const open = s.search(/\\\[|\$\$/);
      if (open < 0) { n += countLineWords(s); break; }
      n += countLineWords(s.slice(0, open));
      s = s.slice(open + 2);
      inDisplay = true;
    }
  }
  return n;
}

/* ---------------- derived views, computed off the typing path ----------------
   The TOC, the TODO list, the include list and the word count are all linear
   passes over the document. Solid memos are EAGER — as plain memos they re-ran
   on every document change even when the side panel was closed, so a big
   project paid four full scans per edit for output nobody was looking at.

   They live in signals instead, recomputed in ONE scheduled batch that runs
   after typing settles and only when the browser is idle. Big documents get a
   longer leash. Nothing here is on the keystroke path. */

export const [toc, setToc] = createSignal([]);
export const [todos, setTodos] = createSignal([]);
export const [includes, setIncludes] = createSignal([]);
export const [wordCount, setWordCount] = createSignal(0);

const idle = (fn, timeout) => (typeof requestIdleCallback === 'function'
  ? requestIdleCallback(fn, { timeout })
  : setTimeout(fn, 1));
const cancelIdle = (h) => (typeof cancelIdleCallback === 'function'
  ? cancelIdleCallback(h)
  : clearTimeout(h));

let deriveHandle = 0;
let deriveTimer = null;

/** Recompute every derived view of the document, off the typing path. */
export function scheduleDerived(src) {
  clearTimeout(deriveTimer);
  if (deriveHandle) { cancelIdle(deriveHandle); deriveHandle = 0; }
  if (!src) {
    setToc([]); setTodos([]); setIncludes([]); setWordCount(0);
    return;
  }
  const big = srcLength(src) > 2_000_000;
  deriveTimer = setTimeout(() => {
    deriveHandle = idle(() => {
      deriveHandle = 0;
      try {
        // Structure first (it drives the visible tree and the breadcrumbs);
        // the word count is a number in the corner, so it goes last.
        setToc(parseTOC(src));
        setTodos(parseTodos(src));
        setIncludes(parseIncludes(src));
        setWordCount(countWords(src));
      } catch (_) { /* document swapped mid-pass */ }
    }, big ? 4000 : 1000);
  }, big ? 800 : 250);
}
