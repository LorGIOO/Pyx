// \hoja and \celda: values of an Excel workbook (or a CSV) placed in the
// document, the way \pynotebook and \py{} place a notebook's — but without
// Python: the compiler reads the cells (src-tauri/src/sheets.rs).
//
//   \hoja[Cargas]{datos/cargas.xlsx}   links the workbook and its sheet,
//                                      from that point on (paths relative to
//                                      the main document, as for \input)
//   \celda{E4}                         one cell
//   \celda{E4:E8}                      a column, a row or a table, written as
//                                      the body of a tabular
//   \celda[T]{E4:E8}                   the same, transposed (column <-> row)
//   \celda{Resumen!B2}                 another sheet of the same workbook
//
// Every compile reads the file again if it changed: edit in Excel, save, and
// compile.
import { protectedRanges, inTexComment } from './latex-bridge.js';

const HOJA_RE = /\\hoja\s*(?:\[([^\]]*)\])?\s*\{([^{}]*)\}/g;
const CELDA_RE = /\\celda\s*(?:\[([^\]]*)\])?\s*\{([^{}]*)\}/g;

function inRanges(ranges, i) {
  for (const [a, b] of ranges) if (i >= a && i < b) return true;
  return false;
}

/** Every \hoja and \celda of a text, in order, outside verbatim and comments. */
export function findSheetCommands(text) {
  if (text.indexOf('\\hoja') < 0 && text.indexOf('\\celda') < 0) return [];
  const skip = protectedRanges(text);
  const out = [];
  for (const [re, kind] of [[HOJA_RE, 'hoja'], [CELDA_RE, 'celda']]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      if (inRanges(skip, m.index) || inTexComment(text, m.index)) continue;
      out.push({ kind, start: m.index, end: m.index + m[0].length, opt: (m[1] || '').trim(), arg: m[2].trim() });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Which cells a text needs: [{ link: {path, sheet}, ref, transpose, cmd }],
 * the link being the \hoja in force at each \celda. `inherited` is the link
 * in force where the file starts (the main document's first \hoja, for a
 * chapter that has none of its own before its cells).
 */
export function sheetRequests(text, inherited = null) {
  let link = inherited;
  const reqs = [];
  for (const c of findSheetCommands(text)) {
    if (c.kind === 'hoja') link = { path: c.arg, sheet: c.opt };
    else reqs.push({ link, ref: c.arg, transpose: /^t$/i.test(c.opt), cmd: c });
  }
  return { reqs, last: link };
}

const ESC = { '&': '\\&', '%': '\\%', $: '\\$', '#': '\\#', _: '\\_', '{': '\\{', '}': '\\}', '~': '\\textasciitilde{}', '^': '\\textasciicircum{}', '\\': '\\textbackslash{}' };

/** One cell's value as LaTeX: numbers as Excel saved them (no float noise),
 *  text escaped — a sheet holds plain text, not LaTeX. */
export function cellTeX(v) {
  if (v == null) return '';
  if (typeof v === 'boolean') return v ? 'VERDADERO' : 'FALSO';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return '';
    if (Number.isInteger(v)) return String(v);
    const s = String(+v.toPrecision(12));
    return /e/i.test(s) ? v.toFixed(10).replace(/0+$/, '') : s;
  }
  return String(v).replace(/[&%$#_{}~^\\]/g, (c) => ESC[c]);
}

/** A grid of values as LaTeX: one value, a row (`a & b`), a column
 *  (`a \\ b \\`) or a table — on ONE line, so the build keeps its line map. */
export function gridTeX(grid, transpose = false) {
  let g = grid || [];
  if (transpose && g.length) g = g[0].map((_, j) => g.map((row) => row[j]));
  if (g.length === 1 && g[0].length === 1) return cellTeX(g[0][0]);
  if (g.length === 1) return g[0].map(cellTeX).join(' & ');
  if (g.every((row) => row.length === 1)) return g.map((row) => `${cellTeX(row[0])} \\\\`).join(' ');
  return g.map((row) => `${row.map(cellTeX).join(' & ')} \\\\`).join(' ');
}

/** Replace each \celda of `text` with its value, and each \hoja with
 *  \relax: in the copy LaTeX reads, a \hoja may sit in the preamble, before
 *  any definition of it could. `valueOf` maps a request to {ok, tex, error}. */
export function resolveSheets(text, inherited, valueOf) {
  const cmds = findSheetCommands(text);
  if (!cmds.length) return { text, problems: [], last: inherited };
  const problems = [];
  let link = inherited;
  let out = '';
  let at = 0;
  for (const c of cmds) {
    out += text.slice(at, c.start);
    if (c.kind === 'hoja') {
      link = { path: c.arg, sheet: c.opt };
      out += '\\relax{}';
    } else {
      const r = { link, ref: c.arg, transpose: /^t$/i.test(c.opt), cmd: c };
      const v = valueOf(r);
      if (v && v.ok) out += v.tex;
      else problems.push({ at: out.length, message: `\\celda{${r.ref}}: ${(v && v.error) || 'sin valor'}` });
    }
    at = c.end;
  }
  return { text: out + text.slice(at), problems, last: link };
}

export const requestKey = (r, base) => `${base}|${(r.link && r.link.path) || ''}|${(r.link && r.link.sheet) || ''}|${r.ref}`;
