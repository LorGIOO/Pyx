// Search across every file of a project — TeXstudio's "Buscar en archivos",
// VS Code's Ctrl+Shift+F. Pure: the panel gives it the texts (the open
// documents as they are in the editor, the rest from disk) and gets back
// every match with its line, column and the line itself.

import { decodeBytes, encodeText } from '../core/encoding.js';

/** The RegExp for a query, or null if it is empty or an invalid pattern. */
export function queryRegExp(query, { caseSensitive = false, regexp = false, whole = false } = {}) {
  if (!query) return null;
  let src = regexp ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (whole) src = `(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])`;
  try {
    return new RegExp(src, `gu${caseSensitive ? '' : 'i'}`);
  } catch (_) {
    return null;
  }
}

/* Every match of `re` in `text`, LINE BY LINE: `visit(lineNo, lineStart,
 * lineText, match)`; returning false stops the walk.
 *
 * The one definition of "a match" that both the result list and «Reemplazar
 * todo» use. They used to disagree: the list searched each line on its own,
 * while the replace ran the expression over the whole text — so `\s+` or
 * `[^}]*` ate line breaks that the list never showed, `^` meant "start of the
 * file" instead of "start of a line", and the count in the confirmation was
 * not the number of changes made. A match never spans a line break, and an
 * empty match is not a match. */
function eachMatch(text, re, visit) {
  const br = /\r?\n/g;
  let start = 0;
  let lineNo = 1;
  for (;;) {
    const nl = br.exec(text);
    const line = text.slice(start, nl ? nl.index : text.length);
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line))) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      if (visit(lineNo, start, line, m) === false) return;
    }
    if (!nl) return;
    start = nl.index + nl[0].length;
    lineNo++;
  }
}

/**
 * @param {{path:string, text:string}[]} files
 * @returns {{files: {path:string, matches:{line:number, col:number, len:number, text:string}[]}[], total:number, capped:boolean}}
 */
export function searchTexts(files, query, opts = {}, max = 5000) {
  const re = queryRegExp(query, opts);
  const out = { files: [], total: 0, capped: false };
  if (!re) return out;
  for (const f of files) {
    const matches = [];
    eachMatch(f.text, re, (lineNo, _start, line, m) => {
      matches.push({ line: lineNo, col: m.index, len: m[0].length, text: line });
      if (++out.total >= max) { out.capped = true; return false; }
      return true;
    });
    if (matches.length) out.files.push({ path: f.path, matches });
    if (out.capped) break;
  }
  return out;
}

/**
 * The edits «Reemplazar todo» makes in `text`: one `{from, to, insert}` per
 * match, in document order, with offsets into `text` — exactly the matches
 * searchTexts lists. `$1`… and `$&` work with regular expressions.
 */
export function replaceEdits(text, query, replacement, opts = {}) {
  const re = queryRegExp(query, opts);
  const edits = [];
  if (!re) return edits;
  eachMatch(text, re, (_n, start, _line, m) => {
    const insert = opts.regexp
      // Expand $1, $2… and $& like String.prototype.replace would.
      ? replacement.replace(/\$(\d+|&)/g, (_, g) => (g === '&' ? m[0] : ((+g > 0 ? m[+g] : '') ?? '')))
      : replacement;
    edits.push({ from: start + m.index, to: start + m.index + m[0].length, insert });
  });
  return edits;
}

/**
 * «Reemplazar todo» in a file that is NOT open, on its bytes: decoded as the
 * editor would, replaced, and encoded back the way the file was — same
 * encoding, same BOM, every line break untouched.
 *
 * The replace used to take the text the search had read (Rust, lossy UTF-8)
 * and write it back as UTF-8: one «Reemplazar todo» re-encoded every Latin-1
 * chapter it touched and turned each accent in it into U+FFFD, for good.
 *
 * `unmappable` lists the characters of the result the file's encoding cannot
 * hold (the replacement text brought them): the caller must then not write.
 *
 * @returns {{bytes:Uint8Array, count:number, unmappable:string[]}}
 */
export function replaceInBytes(bytes, query, replacement, opts = {}) {
  const d = decodeBytes(bytes);
  const { text, count } = replaceInText(d.text, query, replacement, opts);
  if (!count) return { bytes, count: 0, unmappable: [] };
  // A pure-ASCII file has no encoding of its own; UTF-8 holds anything the
  // replacement adds and leaves the rest of the bytes as they were.
  const out = encodeText(text, { encoding: d.encoding, bom: d.bom, eol: null });
  return { bytes: out.bytes, count, unmappable: out.unmappable };
}

/** `text` with every match replaced (see replaceEdits). */
export function replaceInText(text, query, replacement, opts = {}) {
  const edits = replaceEdits(text, query, replacement, opts);
  if (!edits.length) return { text, count: 0 };
  let out = '';
  let at = 0;
  for (const e of edits) {
    out += text.slice(at, e.from) + e.insert;
    at = e.to;
  }
  return { text: out + text.slice(at), count: edits.length };
}
