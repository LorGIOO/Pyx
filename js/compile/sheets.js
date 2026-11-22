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
//   \celda{Caudal}                     a name defined in Excel (Formulas ->
//                                      Name Manager)
//
// Formatting, in the optional argument (comma-separated, any order):
//   .3f  ,.2f  +.1f  .2%  .3e  .0f  .4g Python's format-spec mini-language
//   {:.2f}\,kN                        a Python-style template: {} or {:spec}
//                                      is the value, the rest is LaTeX
//   abs                                absolute value
//   coma  (or dec=,)                   decimal comma (thousands: thin space)
//   cmd=\textbf   color=red   math     wrap EVERY value (math: \ensuremath)
//   T                                  transpose a range
// And plain LaTeX around it works as for any text: \textbf{\celda{E4}},
// $\celda{E4}$, \textcolor{red}{\celda{E4}}. Around a RANGE (whose cells
// are separated by & and \\) such a wrapper is applied to each cell.
//
// Every compile reads the file again if it changed: edit in Excel, save, and
// compile.
import { protectedRanges, inTexComment } from './latex-bridge.js';
import { t } from '../core/i18n.js';

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
    else reqs.push({ link, ref: c.arg, transpose: parseCellOptions(c.opt).transpose, cmd: c });
  }
  return { reqs, last: link };
}

/* ---------------- formatting ---------------- */

// Python's format spec: [[fill]align][sign][,|_][.precision][type]
const SPEC_RE = /^(?:(.)?([<>^=]))?([+\- ])?([,_])?(?:\.(\d+))?([fFeEgGdn%])?$/;
const TOKEN_RES = [
  ['transpose', /^t(?=\s*(?:,|$))/i],
  ['abs', /^abs(?=\s*(?:,|$))/i],
  ['math', /^(?:math|\$)(?=\s*(?:,|$))/i],
  ['comma', /^(?:coma|comma|dec\s*=\s*,)(?=\s*(?:,|$))/i],
  ['dot', /^dec\s*=\s*\.(?=\s*(?:,|$))/i],
  ['cmd', /^cmd\s*=\s*(\\[A-Za-z@]+(?:\{[^{}]*\})*)/],
  ['color', /^colou?r\s*=\s*([A-Za-z0-9!.]+)/],
  // a template: everything up to the next top-level comma
  // (`\,` and other escaped characters belong to it, not to the option list)
  ['template', /^((?:\\.|[^,{}\\]|\{[^{}]*\})*?\{(?::[^{}]*)?\}(?:\\.|[^,{}\\]|\{[^{}]*\})*)/],
  ['spec', /^((?:.?[<>^=])?[+\- ]?[,_]?(?:\.\d+)?[fFeEgGdn%]|(?:.?[<>^=])?[+\- ]?[,_]?\.\d+)(?=\s*(?:,|$))/],
];

/** `T, .3f, abs, cmd=\textbf` -> { transpose, spec, abs, comma, wrap[], template, errors[] } */
export function parseCellOptions(opt) {
  const o = { transpose: false, spec: '', abs: false, comma: null, math: false, cmds: [], color: '', template: '', errors: [] };
  let rest = String(opt || '').trim();
  while (rest) {
    rest = rest.replace(/^\s+/, '');
    if (!rest) break;
    let hit = false;
    for (const [kind, re] of TOKEN_RES) {
      const m = re.exec(rest);
      if (!m) continue;
      hit = true;
      rest = rest.slice(m[0].length);
      if (kind === 'transpose') o.transpose = true;
      else if (kind === 'abs') o.abs = true;
      else if (kind === 'math') o.math = true;
      else if (kind === 'comma') o.comma = true;
      else if (kind === 'dot') o.comma = false;
      else if (kind === 'cmd') o.cmds.push(m[1]);
      else if (kind === 'color') o.color = m[1];
      else if (kind === 'template') o.template = m[1].trim();
      else o.spec = m[1];
      rest = rest.replace(/^\s*,/, ''); // the separator after it
      break;
    }
    if (!hit) {
      const bad = rest.split(',')[0].trim();
      o.errors.push(bad);
      rest = rest.slice(rest.indexOf(bad) + bad.length).replace(/^\s*,/, '');
    }
  }
  return o;
}

const groupDigits = (int, sep) => int.replace(/\B(?=(\d{3})+(?!\d))/g, sep);

/** A number formatted like Python's format(v, spec), as LaTeX. */
export function formatNumber(v, spec = '', { comma = false } = {}) {
  const m = SPEC_RE.exec(spec || '');
  if (!m) return null;
  const [, fill = ' ', align, sign = '-', group, precS, type0] = m;
  const prec = precS === undefined ? null : +precS;
  let type = type0 || (prec !== null ? 'g' : '');
  let x = v;
  let body;
  let exp = null;
  let pct = false;
  const neg = x < 0 || Object.is(x, -0);
  x = Math.abs(x);
  if (type === '%') { x *= 100; type = 'f'; pct = true; }
  if (type === 'f' || type === 'F') body = x.toFixed(prec ?? 6);
  else if (type === 'd' || type === 'n') body = Math.round(x).toFixed(0);
  else if (type === 'e' || type === 'E') {
    const [mant, e] = x.toExponential(prec ?? 6).split('e');
    body = mant; exp = parseInt(e, 10);
  } else if (type === 'g' || type === 'G') {
    const p = Math.max(1, prec ?? 6);
    const e = x === 0 ? 0 : Math.floor(Math.log10(x));
    if (e < -4 || e >= p) {
      const [mant, ee] = x.toExponential(p - 1).split('e');
      body = mant.includes('.') ? mant.replace(/\.?0+$/, '') : mant; exp = parseInt(ee, 10);
    } else {
      body = x.toFixed(Math.max(0, p - 1 - e));
      if (body.includes('.')) body = body.replace(/\.?0+$/, '');
    }
  } else body = String(+x.toPrecision(12));
  let [int, frac] = body.split('.');
  if (group) int = groupDigits(int, comma ? '\\,' : '{,}');
  let out = frac !== undefined ? `${int}${comma ? '{,}' : '.'}${frac}` : int;
  if (exp !== null) out = `\\ensuremath{${out}\\times10^{${exp}}}`;
  if (pct) out += '\\%';
  const sg = neg && +body !== 0 ? '-' : (sign === '+' ? '+' : sign === ' ' ? '~' : '');
  out = sg + out;
  if (align && fill && fill !== ' ') { /* LaTeX ignores padding: nothing to do */ }
  return out;
}

/** One value with the options of its \celda applied. */
export function formatCell(v, o) {
  let tex;
  let num = typeof v === 'number' && Number.isFinite(v) ? v : null;
  if (num !== null && o.abs) num = Math.abs(num);
  // Python-style template: {} / {:spec} is the value, the rest LaTeX as written.
  const fmt = (spec) => (num !== null && spec ? formatNumber(num, spec, o) ?? cellTeX(num, o) : cellTeX(num !== null ? num : v, o));
  if (o.template) {
    tex = o.template.replace(/\{(?::([^{}]*))?\}/, (_, spec) => fmt(spec || o.spec));
  } else tex = fmt(o.spec);
  if (o.math) tex = `\\ensuremath{${tex}}`;
  for (const c of [...o.cmds].reverse()) tex = `${c}{${tex}}`;
  if (o.color) tex = `\\textcolor{${o.color}}{${tex}}`;
  return tex;
}

const ESC = { '&': '\\&', '%': '\\%', $: '\\$', '#': '\\#', _: '\\_', '{': '\\{', '}': '\\}', '~': '\\textasciitilde{}', '^': '\\textasciicircum{}', '\\': '\\textbackslash{}' };

/** One cell's value as LaTeX: numbers as Excel saved them (no float noise),
 *  text escaped — a sheet holds plain text, not LaTeX. */
export function cellTeX(v, o = {}) {
  if (v == null) return '';
  if (typeof v === 'boolean') return v ? 'VERDADERO' : 'FALSO';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return '';
    if (Number.isInteger(v)) return String(v);
    const s = String(+v.toPrecision(12));
    const t = /e/i.test(s) ? v.toFixed(10).replace(/0+$/, '') : s;
    return o.comma ? t.replace('.', '{,}') : t;
  }
  return String(v).replace(/[&%$#_{}~^\\]/g, (c) => ESC[c]);
}

/** A grid of values as LaTeX: one value, a row (`a & b`), a column
 *  (`a \\ b \\`) or a table — on ONE line, so the build keeps its line map. */
export function gridTeX(grid, transpose = false, o = null, wrap = null) {
  let g = grid || [];
  if (transpose && g.length) g = g[0].map((_, j) => g.map((row) => row[j]));
  const one = (v) => {
    const t = o ? formatCell(v, o) : cellTeX(v);
    return wrap ? wrap(t) : t;
  };
  if (g.length === 1 && g[0].length === 1) return one(g[0][0]);
  if (g.length === 1) return g[0].map(one).join(' & ');
  if (g.every((row) => row.length === 1)) return g.map((row) => `${one(row[0])} \\\\`).join(' ');
  return g.map((row) => `${row.map(one).join(' & ')} \\\\`).join(' ');
}

// LaTeX written AROUND a \celda: `\textbf{` … `}`, `\textcolor{red}{` … `}`,
// `$` … `$`, `\(` … `\)`. For a range it is moved onto every cell.
const WRAP_BEFORE = /(\\[A-Za-z@]+\*?(?:\[[^\]]*\])?(?:\{[^{}]*\})*\{\s*|\$\s*|\\\(\s*)$/;
function wrapperAround(before, after) {
  const m = WRAP_BEFORE.exec(before);
  if (!m) return null;
  const open = m[1].trim();
  const close = open === '$' ? /^\s*\$/ : open === '\\(' ? /^\s*\\\)/ : /^\s*\}/;
  const c = close.exec(after);
  if (!c) return null;
  if (open === '$' && (/\$\s*\$$/.test(before) || /^\s*\$\s*\$/.test(after))) return null; // $$…$$
  return { openLen: m[1].length, closeLen: c[0].length, open, close: c[0].trim() };
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
      const o = parseCellOptions(c.opt);
      const r = { link, ref: c.arg, transpose: o.transpose, cmd: c };
      const v = valueOf(r);
      if (o.errors.length) problems.push({ at: out.length, message: `\\celda[${c.opt}]{${r.ref}}: ${t('opción desconocida', 'unknown option')} ${o.errors.map((e) => `«${e}»`).join(', ')}` });
      if (v && v.ok) {
        const grid = v.grid || [[v.tex]];
        const many = grid.length > 1 || (grid[0] && grid[0].length > 1);
        const w = many ? wrapperAround(out, text.slice(c.end)) : null;
        if (w) {
          // Move the wrapper onto every cell: drop it from both sides.
          out = out.slice(0, out.length - w.openLen);
          out += gridTeX(grid, o.transpose, o, (t) => `${w.open}${t}${w.close}`);
          at = c.end + w.closeLen;
          continue;
        }
        // An empty cell writes nothing: say so, instead of a silent gap.
        if (v.grid && grid.every((row) => row.every((x) => x == null || x === ''))) {
          problems.push({ at: out.length, message: `\\celda{${r.ref}}: ${t('la celda está vacía en el libro (¿una celda combinada o una fórmula sin resultado guardado?)', 'the cell is empty in the workbook (a merged cell, or a formula with no saved result?)')}` });
        }
        out += v.grid ? gridTeX(grid, o.transpose, o) : v.tex;
      } else problems.push({ at: out.length, message: `\\celda{${r.ref}}: ${(v && v.error) || t('sin valor', 'no value')}` });
    }
    at = c.end;
  }
  return { text: out + text.slice(at), problems, last: link };
}

export const requestKey = (r, base) => `${base}|${(r.link && r.link.path) || ''}|${(r.link && r.link.sheet) || ''}|${r.ref}`;
