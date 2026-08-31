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
import { hashString } from '../core/hash.js';

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

/* ---------------- protected ranges (memoized, bisected) -------------------
   PERFORMANCE CONTRACT — read before changing anything here.

   `protectedRanges` is a full linear scan of the document, and almost every
   other function in this module needs it. It used to be recomputed from
   scratch on every single call — and `findPyExprs`, `findPyIfExprs`,
   `collectPyIfConds`, `resolvePyText` and `escapePyStar` each call it, with
   `resolvePyIf` calling it up to twenty more times in its fixpoint loop. A
   single compile therefore rescanned every file of the project dozens of
   times.

   Worse, membership was tested with `ranges.some(...)` — a LINEAR walk — once
   per `\py{}` occurrence, so a document with many verbatim blocks and many
   `\py{}` calls degraded to O(occurrences × ranges): quadratic.

   Two fixes: memoize the scan (a small LRU keyed by the text, which the caller
   is holding anyway), and bisect the ranges instead of scanning them. The
   ranges are produced in document order and are disjoint by construction, so a
   bisect is exact. */

const rangeCache = new Map(); // fingerprint -> ranges (insertion-ordered LRU)
const RANGE_CACHE_MAX = 24;   // a project's worth of open files, bounded

/** Character ranges of text that must NOT be interpreted: lines inside
 * verbatim environments plus inline \verb|…| / \verb*|…| spans.
 * Returned sorted by start and non-overlapping. */
export function protectedRanges(text) {
  // Keyed by a FINGERPRINT of the text, not the text itself: using whole
  // documents as Map keys retained a dozen complete copies of the project in
  // memory. The length is mixed in, so a hash collision would also have to
  // match the exact size to matter.
  const key = text.length + ':' + hashString(text);
  const hit = rangeCache.get(key);
  if (hit) return hit;

  const ranges = [];
  const inVerb = createVerbatimTracker();
  let pos = 0;
  for (const line of text.split('\n')) {
    const end = pos + line.length;
    if (inVerb(line)) {
      ranges.push([pos, end]);
    } else if (line.indexOf('\\verb') >= 0) { // cheap reject for the common line
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

  if (rangeCache.size >= RANGE_CACHE_MAX) {
    rangeCache.delete(rangeCache.keys().next().value); // evict oldest
  }
  rangeCache.set(key, ranges);
  return ranges;
}

/** Is offset `i` inside a protected range? Bisect — the ranges are sorted and
 *  disjoint, and this is called once per candidate occurrence. */
function inRanges(ranges, i) {
  let lo = 0, hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = ranges[mid];
    if (i < r[0]) hi = mid - 1;
    else if (i >= r[1]) lo = mid + 1;
    else return true;
  }
  return false;
}

/**
 * Find every \py{...} occurrence, matching balanced braces so f-strings like
 * \py{f"{x:.2f}"} work. Returns [{start, end, expr}] with [start,end) covering
 * the whole \py{...} token. Occurrences inside verbatim contexts (minted,
 * verbatim, \verb…) are literal text and are NOT returned.
 */
export function findPyExprs(text) {
  const out = [];
  const needle = '\\py{';
  // Early out BEFORE the protected-ranges scan: most files in a big project are
  // plain LaTeX prose with no \py{} at all, and scanning them was the single
  // biggest cost of a multi-file compile.
  if (text.indexOf(needle) < 0) return out;
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
 *
 * The `{else}` group is OPTIONAL: `\pyif{cond}{then}` shows `then` or nothing.
 * Besides being useful on its own, it is what keeps a mistyped three-branch
 * call off the page. Left unparsed, `\pyif{c}{a}\textcolor{green}{Ok}` (one
 * brace short) would reach the engine, which grabs `\textcolor` as the third
 * argument and prints the leftovers — "greenOk" — right into the PDF.
 */
export function findPyIfExprs(text) {
  const out = [];
  const needle = '\\pyif{';
  if (text.indexOf(needle) < 0) return out; // early out (see findPyExprs)
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
    const g3 = text[g2.end] === '{' ? readGroup(text, g2.end) : null;
    if (text[g2.end] === '{' && !g3) break; // opened but never closed
    out.push({
      start: at,
      end: g3 ? g3.end : g2.end,
      cond: g1.inner,
      thenText: g2.inner,
      elseText: g3 ? g3.inner : '',
    });
    i = g3 ? g3.end : g2.end;
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

/**
 * Replace each \pyif{cond}{then}{else} with the branch its condition selects.
 *
 * A selected branch can itself contain a \pyif, so we resolve THAT BRANCH
 * directly (it is a short string) instead of re-scanning the whole document.
 * The old code ran a fixpoint loop over the entire text — up to twenty full
 * rescans of every file, on every compile, to resolve nesting that is almost
 * never deeper than two.
 */
export function resolvePyIf(text, valueMap, depth = 0) {
  if (depth > 20) return text; // pathological nesting guard
  const ifs = findPyIfExprs(text);
  if (!ifs.length) return text;
  let out = '';
  let cursor = 0;
  for (const e of ifs) {
    out += text.slice(cursor, e.start);
    const v = valueMap[pyifKey(e.cond)];
    const branch = v && v.ok && v.value === 'True' ? e.thenText : e.elseText;
    out += resolvePyIf(branch, valueMap, depth + 1);
    cursor = e.end;
  }
  out += text.slice(cursor);
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
 * escaped \py*{expr} with typeset-able literal text.
 *
 * An expression that FAILED contributes nothing — not a placeholder. The PDF
 * is the deliverable and it must never carry a trace of the incident; the
 * failure is reported in the app (compileActive lists every failed \py{} and
 * \pyif{} in the log panel), which is where the user can act on it. */
export function resolvePyText(text, valueMap) {
  const exprs = findPyExprs(text);
  let out = text;
  if (exprs.length) {
    out = '';
    let cursor = 0;
    for (const e of exprs) {
      out += text.slice(cursor, e.start);
      const v = valueMap[e.expr];
      out += v && v.ok ? v.value : '';
      cursor = e.end;
    }
    out += text.slice(cursor);
  }
  return escapePyStar(out);
}

/**
 * Prepare the %#python … %#end blocks for the LaTeX engine.
 *
 * The build copy is CLEAN, PORTABLE LaTeX — it must compile in TeXstudio (or
 * any editor) with no Python at all:
 *
 * - A normal cell disappears entirely from the build: no markers, no
 *   commented-out code. Its values reach the document only through \py{...},
 *   which the compiler substitutes with the computed results.
 * - A handcalcs cell (one using %%render / %%tex) is REPLACED in place by the
 *   LaTeX that handcalcs produced — readable, multi-line (blank lines dropped:
 *   a paragraph break inside display math is a TeX error). `renders` maps a
 *   cell's STABLE key (its `id=`, or its ordinal) to that LaTeX.
 *
 * Deleting lines shifts every line number below a cell, so this returns
 * `{ text, srcLines }`: srcLines[i] is the 1-based SOURCE line that produced
 * build line i+1 (for a handcalcs render, every render line maps to the cell's
 * %#python header). SyncTeX (both directions) and the log parser translate
 * through this map — without it, jumps and error lines land off by the size of
 * every cell above them. `srcLines` is null when nothing changed (identity).
 */
export function neutralizeCells(text, renders = {}) {
  // Early out: a file with no cell markers comes back byte-for-byte identical.
  if (text.indexOf('%#python') < 0) return { text, srcLines: null };
  const hasRenders = renders && Object.keys(renders).length > 0;
  const lines = text.split(/\r?\n/);
  const out = [];
  const srcLines = [];
  const inVerb = createVerbatimTracker();
  let cellIndex = -1;
  let i = 0;
  while (i < lines.length) {
    // Inside minted/verbatim the markers are DISPLAYED code, not a cell:
    // pass the line through untouched (the engine typesets it as-is).
    if (inVerb(lines[i])) {
      out.push(lines[i]);
      srcLines.push(i + 1);
      i++;
      continue;
    }
    if (lines[i].trim().startsWith('%#python')) {
      const open = i;
      cellIndex++;
      // Renders are filed under the cell's STABLE key — its `id=`, or its
      // ordinal for a legacy cell. Keying by the cell's CODE (as this used to)
      // meant two cells with the same body shared one rendered block.
      const idm = /\bid\s*=\s*([A-Za-z0-9_-]{1,32})/.exec(lines[i]);
      const key = idm ? idm[1] : '#' + cellIndex;
      const code = [];
      let j = i + 1;
      while (j < lines.length && !lines[j].trim().startsWith('%#end')) { code.push(lines[j]); j++; }
      const latex = hasRenders ? renders[key] : undefined;
      if (latex != null) {
        // Handcalcs cell: its typeset LaTeX takes the cell's place. Every
        // emitted line maps back to the cell's header line.
        for (const ln of latex.split(/\r?\n/)) {
          if (!ln.trim()) continue; // no paragraph breaks inside display math
          out.push(ln);
          srcLines.push(open + 1);
        }
      }
      // Normal cell: nothing is emitted — the build has no trace of it.
      i = j < lines.length ? j + 1 : j;
    } else {
      out.push(lines[i]);
      srcLines.push(i + 1);
      i++;
    }
  }
  return { text: out.join('\n'), srcLines };
}

/* ---------------- build hardening: nothing internal reaches the page ------
   The PDF is the deliverable. It must show RESULTS — never how they were
   obtained, and never a trace of something having gone wrong. Two things can
   spill onto a page, and both are silent:

   1. A verbatim environment THE DOCUMENT NEVER DEFINED. Pyx treats
      `lstlisting`, `minted`, … as literal code (correctly — the author is
      showing code, not running it), but if the preamble forgot
      \usepackage{listings} the engine has no such environment: it recovers by
      typesetting the block as ordinary text. `[style=pyxtex]` prints as-is,
      `\py{round(A,4)}` prints "round(A, 4)", and `\pyif{c}{a}{b}` dumps all
      three branches into the page — exactly the internals the user must never
      see.

   2. A \py{} / \pyif{} Pyx could not resolve — a failed expression, or a
      malformed call (a missing brace) the parser could not read. Undefined in
      TeX, the braces get typeset as text.

   `safetyPreamble` closes both. It defines every verbatim environment the
   project actually opens and every lstlisting style it names, and it defines
   \py / \py* / \pyif as macros that swallow their arguments and print
   nothing. Whatever went wrong is reported IN THE APP; the page stays clean.

   Everything is guarded (\@ifundefined / \providecommand), so a document that
   already loads its packages is left exactly as it was. */

// How to make a verbatim environment exist when the document never loaded the
// package providing it. `minted` is deliberately NOT auto-loaded: it needs
// shell-escape plus an external highlighter, and a missing highlighter fails
// harder than plain type. A verbatim box is all Pyx needs it to be.
const VERBATIM_PROVIDER = {
  lstlisting: '\\usepackage{listings}',
  minted: '\\usepackage{fancyvrb}'
    + '\\newenvironment{minted}[2][]{\\VerbatimEnvironment\\begin{Verbatim}}{\\end{Verbatim}}',
  Verbatim: '\\usepackage{fancyvrb}',
  BVerbatim: '\\usepackage{fancyvrb}',
  LVerbatim: '\\usepackage{fancyvrb}',
  alltt: '\\usepackage{alltt}',
  comment: '\\usepackage{comment}',
  // `verbatim` and `filecontents` are part of LaTeX2e itself.
};

// Stand-in for an lstlisting style the project names but never defines.
const STYLE_FALLBACK = 'basicstyle=\\ttfamily\\small,breaklines=true,'
  + 'columns=fullflexible,showstringspaces=false,keepspaces=true';

const reBeginOpt = /\\begin\s*\{([A-Za-z]+)\*?\}[ \t]*(?:\[([^\]]*)\])?/g;
const reStyleOpt = /(?:^|,)\s*style\s*=\s*([A-Za-z@][A-Za-z@0-9]*)/;

/** Record the verbatim environments (and lstlisting styles) one line opens.
 *  Called from the compiler's single per-file walk — the guards must cost no
 *  extra pass over a project that can be tens of megabytes. */
export function scanVerbatimUse(line, out) {
  if (line.indexOf('\\begin') < 0) return;
  reBeginOpt.lastIndex = 0;
  let m;
  while ((m = reBeginOpt.exec(line))) {
    if (!VERBATIM_ENVS.has(m[1])) continue;
    out.envs.add(m[1]);
    // \begin{lstlisting}[style=NAME] — an undefined style errors out too.
    const s = m[2] && reStyleOpt.exec(m[2]);
    if (s) out.styles.add(s[1]);
  }
}

/**
 * The guard block for the ROOT build's preamble, or null when nothing needs
 * guarding.
 *
 * `envs` / `styles` are aggregated over the WHOLE project: a child's
 * \begin{lstlisting} needs `listings` loaded in the ROOT preamble.
 */
export function safetyPreamble({ envs, styles, usesPy, usesGraphics }) {
  const guards = [];
  const seen = new Set();
  // A \py{} can expand to an \includegraphics — `figtex()` in the kernel
  // returns a whole figure float — so the package may be needed by text that
  // does not exist until substitution time. The guard is a no-op when the
  // preamble already loads it.
  if (usesGraphics || usesPy) {
    guards.push('\\@ifundefined{includegraphics}{\\usepackage{graphicx}}{}');
  }
  for (const env of envs) {
    const provider = VERBATIM_PROVIDER[env];
    if (!provider || seen.has(provider)) continue;
    seen.add(provider);
    guards.push(`\\@ifundefined{${env}}{${provider}}{}`);
  }
  if (envs.has('lstlisting')) {
    for (const s of styles) {
      guards.push(
        `\\@ifundefined{lst@style@${s}}{\\lstdefinestyle{${s}}{${STYLE_FALLBACK}}}{}`);
    }
  }
  if (usesPy) {
    // A \py{}/\pyif{} that survived resolution prints NOTHING instead of
    // spilling its arguments. \py* is handled too (\@ifstar).
    guards.push('\\providecommand\\Pyx@eat@i[1]{}');
    guards.push('\\providecommand\\py{\\@ifstar\\Pyx@eat@i\\Pyx@eat@i}');
    guards.push('\\providecommand\\pyif[3]{}');
  }
  if (!guards.length) return null;

  return [
    '% ---- Pyx: garantías de compilación (generado automáticamente) ----',
    '\\makeatletter',
    ...guards,
    '\\makeatother',
    '% ---- fin de las garantías de Pyx ----',
  ].join('\n');
}

/**
 * Insert `block` immediately before \begin{document}.
 *
 * Returns `{ text, atIndex, count, buildLine }` — `atIndex` is the 0-based
 * build-line index where the block starts and `count` how many lines it adds,
 * so the caller can keep the build↔source map exact (SyncTeX and the log
 * parser both read it). Returns null when the file has no \begin{document}
 * (an \input'ed fragment: it has no preamble of its own).
 */
export function injectPreamble(text, block) {
  const m = /\\begin\s*\{document\}/.exec(text);
  if (!m) return null;
  const head = text.slice(0, m.index);
  const lineStart = head.lastIndexOf('\n') + 1;
  let buildLine = 1;
  for (let i = 0; i < lineStart; i++) if (text.charCodeAt(i) === 10) buildLine++;
  return {
    text: text.slice(0, lineStart) + block + '\n' + text.slice(lineStart),
    atIndex: buildLine - 1,
    count: block.split('\n').length,
    buildLine,
  };
}

/**
 * Pyx tokens still present in the FINAL build text, outside verbatim: a \py{}
 * whose braces don't balance, or a \pyif{}{}{} the parser could not read (a
 * missing brace is the usual cause). Returns [{ line, token }] with 1-based
 * BUILD lines, for the caller to translate and report in the app.
 */
export function findPyxLeaks(text) {
  const out = [];
  if (text.indexOf('\\py') < 0) return out;
  const skip = protectedRanges(text);
  const re = /\\py(if|\*)?\s*\{/g;
  let m, line = 1, scanned = 0;
  while ((m = re.exec(text))) {
    while (scanned < m.index) { if (text.charCodeAt(scanned) === 10) line++; scanned++; }
    if (inRanges(skip, m.index)) continue;
    // \py*{…} was rewritten to \texttt{\detokenize{\py{…}}}: literal by
    // construction, not a leak.
    if (text.slice(m.index - 12, m.index) === '\\detokenize{') continue;
    out.push({ line, token: m[1] === 'if' ? '\\pyif' : '\\py' });
  }
  return out;
}

/* ---------------- build ↔ source line translation ----------------
   `srcLines` from neutralizeCells is ascending, so both directions bisect. */

/** Source line for a 1-based build line (identity when there is no map). */
export function buildToSrcLine(map, buildLine) {
  if (!map || !map.length) return buildLine;
  return map[Math.max(0, Math.min(map.length - 1, buildLine - 1))];
}

/** First 1-based build line at or after a source line (nearest below when the
 *  source line sits inside a deleted cell at the end of the file). */
export function srcToBuildLine(map, srcLine) {
  if (!map || !map.length) return srcLine;
  let lo = 0, hi = map.length - 1, ans = map.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (map[mid] >= srcLine) { ans = mid; hi = mid - 1; }
    else lo = mid + 1;
  }
  return ans + 1;
}

export const BUILD_SUFFIX = '.build.tex';
