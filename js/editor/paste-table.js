// Pasting into the editor.
//
// 1. A TABLE from Excel, LibreOffice, Word or a web page pastes as a LaTeX
//    tabular — TeXstudio's "Pegar como tabla LaTeX", automatic. What the
//    spreadsheet puts on the clipboard: tab-separated rows as plain text (and
//    HTML alongside); a browser puts the same tab-separated text next to the
//    HTML of a table. Columns are aligned (numbers right, text left), special
//    characters escaped, booktabs rules when the document loads booktabs
//    (\hline otherwise). The plain paste happens FIRST and the table replaces
//    it in a second step, so Ctrl+Z gives back the text as copied.
//
//    Only what IS a table: code indented with tabs (LaTeX or Python copied
//    from another editor) used to come out as a tabular of escaped code, and
//    code copied from GitHub or a documentation page — HTML that lays the
//    lines out in a <table> beside their numbers — likewise.
//
// 2. Everything else pastes as it was copied, minus what should not travel:
//    invisible characters (zero-width spaces, soft hyphens, BOMs, direction
//    marks) that break a command or a word without showing, the ligatures a
//    PDF gives (ﬁ → fi), and — in a Python cell — the non-breaking spaces that
//    Word, Teams or a web page put in code (Python rejects them).
//
// 3. A Python cell copied from Pyx carries its marker's id: pasted next to
//    the original, both cells shared one id — and one output. The copy gets
//    a new id.

import { EditorView } from '@codemirror/view';
import { parseCells, cellAtLine } from './cell-parse.js';
import { randomId } from '../core/hash.js';
import { general } from '../solid/stores/settingsStore.js';

/* The project's preamble, as the last compile saw it (compiler.js): a chapter
   has no \usepackage of its own, so whether the project loads booktabs can
   only be read from its root document. */
let preambleHint = '';
export const setPreambleHint = (text) => { preambleHint = String(text || ''); };
const USES_BOOKTABS = /\\usepackage\s*(?:\[[^\]]*\])?\s*\{[^}]*\bbooktabs\b[^}]*\}/;

const SPECIAL = { '\\': '\\textbackslash{}', '&': '\\&', '%': '\\%', $: '\\$', '#': '\\#', _: '\\_', '{': '\\{', '}': '\\}', '~': '\\textasciitilde{}', '^': '\\textasciicircum{}' };
export const escapeCell = (s) => String(s).trim().replace(/[\\&%$#_{}~^]/g, (c) => SPECIAL[c]);
const NUMERIC = /^[-+−]?(\d{1,3}([.,  ]\d{3})*|\d+)([.,]\d+)?([eE][-+]?\d+)?\s*%?$/;

// Code, not cells of a table: LaTeX commands, Python statements, braces.
const LOOKS_LIKE_CODE = /\\[A-Za-z@]+\s*[[{]|\\(?:hline|item|midrule|toprule|bottomrule)\b|^\s*(?:def|class|import|from|for|while|if|elif|else|return|print)\s|[{};]\s*$/m;

/** Rows of cells from tab-separated text, or null if it is not a table. */
export function parseTsv(text) {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
  if (lines.length < 1 || !lines.some((l) => l.includes('\t'))) return null;
  // A tab that only INDENTS a line is not a column separator.
  const internal = lines.filter((l) => /\S\t/.test(l)).length;
  if (internal < Math.max(1, lines.filter((l) => l.trim()).length * 0.6)) return null;
  if (LOOKS_LIKE_CODE.test(text)) return null;
  // Excel quotes cells holding tabs or newlines: "a""b" → a"b.
  const rows = [];
  let row = [], cell = '', quoted = false;
  const src = lines.join('\n');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === '\t') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  row.push(cell);
  rows.push(row);
  const cols = Math.max(...rows.map((r) => r.length));
  if (cols < 2) return null;
  // A paragraph with a stray tab is not a table: most rows must be full.
  const full = rows.filter((r) => r.length === cols).length;
  if (full < Math.max(1, rows.length * 0.6)) return null;
  return rows.map((r) => [...r, ...Array(cols - r.length).fill('')]);
}

/** Did this HTML come from a spreadsheet (Excel, LibreOffice Calc, Google
 *  Sheets)? Their copy of ONE column has no tab in it, so only the HTML says
 *  that those lines are the rows of a table. */
export const isSpreadsheetHtml = (html) => /urn:schemas-microsoft-com:office:excel|ProgId\s+content=["']?Excel|content=["']?LibreOffice|google-sheets-html-origin|data-sheets-/i.test(html || '');

/** Rows of cells from an HTML table (spreadsheet, web page, Word), or null:
 *  [{ text, span, bold }]. A cell merged DOWNWARDS (rowspan) keeps its text in
 *  its first row and leaves an empty cell in each row below, so every row
 *  still has all its columns. A table that lays out CODE (line numbers beside
 *  the lines: GitHub, Pygments, highlight.js) is not one. */
export function parseHtmlTable(html) {
  if (!/<table/i.test(html)) return null;
  let doc;
  try { doc = new DOMParser().parseFromString(html, 'text/html'); } catch (_) { return null; }
  const table = doc.querySelector('table');
  if (!table) return null;
  if (table.querySelector('pre, code, .blob-code, .highlight, .hljs, .linenos, .lineno, [data-line-number]')
    || /\b(highlight|blob|code|linenos|diff)\b/i.test(`${table.className} ${table.id}`)) return null;
  // Excel styles its cells through classes (.xl65 {font-weight:700}): the
  // parsed document computes no styles, so the bold classes are read here.
  const boldClasses = new Set();
  for (const st of doc.querySelectorAll('style')) {
    const re = /\.([\w-]+)\s*\{[^}]*font-weight\s*:\s*(?:bold|[6-9]00)/gi;
    let m;
    while ((m = re.exec(st.textContent || ''))) boldClasses.add(m[1]);
  }
  const isBold = (td) => td.tagName === 'TH' || !!td.querySelector('b, strong')
    || /font-weight\s*:\s*(?:bold|[6-9]00)/i.test(td.getAttribute('style') || '')
    || [...td.classList].some((c) => boldClasses.has(c));
  const rows = [];
  const carry = []; // column -> rows still covered by a cell merged from above
  for (const tr of table.querySelectorAll('tr')) {
    const row = [];
    let col = 0;
    const put = (cell) => { row.push(cell); col += cell.span; };
    const filler = () => { while (carry[col] > 0) { carry[col]--; put({ text: '', span: 1 }); } };
    for (const td of tr.querySelectorAll('th, td')) {
      filler();
      const span = Math.max(1, Math.min(50, +td.getAttribute('colspan') || 1));
      const down = Math.max(1, Math.min(500, +td.getAttribute('rowspan') || 1));
      const text = td.textContent.replace(/\s+/g, ' ').trim();
      const at = col;
      // `bold` only where it is: the rest of the cells keep their plain shape.
      put(text && isBold(td) ? { text, span, bold: true } : { text, span });
      if (down > 1) for (let k = 0; k < span; k++) carry[at + k] = down - 1;
    }
    filler();
    if (row.length) rows.push(row);
  }
  if (!rows.length) return null;
  return rows;
}

/** Which rules a pasted table gets: what Configuración says, or — on
 *  "automático" — booktabs when the document (or its project) loads it. */
export function tableRules(docText) {
  const pref = general.pasteTableRules;
  if (pref === 'booktabs' || pref === 'hline' || pref === 'none') return pref;
  return USES_BOOKTABS.test(docText || '') || USES_BOOKTABS.test(preambleHint) ? 'booktabs' : 'hline';
}

/** The tabular for rows of strings (or {text, span, bold} for merged cells).
 *  `rules`: 'booktabs' | 'hline' | 'none' (`booktabs: true` is the old way of
 *  asking for the first). `float`: wrap it in a table environment with
 *  \caption and \label. */
export function rowsToTabular(rows, { booktabs = false, rules = null, indent = '', float = false } = {}) {
  const kind = rules || (booktabs ? 'booktabs' : 'hline');
  const cells = rows.map((r) => r.map((c) => (typeof c === 'string' ? { text: c, span: 1 } : c)));
  const cols = Math.max(...cells.map((r) => r.reduce((n, c) => n + c.span, 0)));
  // A column is numeric when every non-empty cell below the header is a number.
  const align = [];
  for (let j = 0; j < cols; j++) {
    const vals = cells.slice(1).map((r) => {
      let k = 0;
      for (const c of r) { if (k === j && c.span === 1) return c.text; k += c.span; }
      return '';
    }).filter((v) => v.trim());
    align.push(vals.length && vals.every((v) => NUMERIC.test(v.trim())) ? 'r' : 'l');
  }
  const cell = (c) => {
    const t = escapeCell(c.text);
    const body = c.bold && t ? `\\textbf{${t}}` : t;
    return c.span > 1 ? `\\multicolumn{${c.span}}{c}{${body}}` : body;
  };
  const line = (r) => {
    // A short row (a ragged selection) is completed, so LaTeX never meets a
    // row with fewer cells than columns.
    const width = r.reduce((n, c) => n + c.span, 0);
    return [...r.map(cell), ...Array(Math.max(0, cols - width)).fill('')].join(' & ') + ' \\\\';
  };
  const rule = { booktabs: ['\\toprule', '\\midrule', '\\bottomrule'], hline: ['\\hline', '\\hline', '\\hline'], none: [null, null, null] }[kind];
  const body = [rule[0], line(cells[0])];
  if (cells.length > 1) body.push(rule[1], ...cells.slice(1).map(line));
  body.push(rule[2]);
  const pad = float ? `${indent}  ` : indent;
  const tabular = `\\begin{tabular}{${align.join('')}}\n${body.filter((l) => l != null).map((l) => `${pad}  ${l}`).join('\n')}\n${pad}\\end{tabular}`;
  if (!float) return tabular;
  return `\\begin{table}[htbp]\n${pad}\\centering\n${pad}\\caption{}\n${pad}\\label{tab:}\n${pad}${tabular}\n${indent}\\end{table}`;
}

// Invisible characters that only break things: zero-width space/joiners,
// word joiner, BOM, soft hyphen, left/right marks and embeddings.
const INVISIBLE = /[​-‍⁠﻿­‎‏‪-‮]/g;
const LIGATURES = { 'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'st', 'ﬆ': 'st' };

/** Pasted text, cleaned for where it lands: `python` (a cell) or LaTeX. */
export function cleanPaste(text, { python = false } = {}) {
  let t = String(text).replace(/\r\n?/g, '\n').replace(INVISIBLE, '');
  t = t.replace(/[ﬀ-ﬆ]/g, (c) => LIGATURES[c] || c);
  // In code a non-breaking space is a SyntaxError ("invalid non-printable
  // character U+00A0"); in LaTeX it is the unbreakable space it means.
  if (python) t = t.replace(/[   ]/g, ' ');
  return t;
}

/** Pasted text whose cell markers repeat an id already in the document (or
 *  in the paste): those copies get a new one. */
export function freshCellIds(text, takenIds) {
  if (text.indexOf('%#python') < 0) return text;
  const taken = new Set(takenIds);
  return text.replace(/^([ \t]*%#python\b[^\n]*?\bid\s*=\s*)([A-Za-z0-9_-]{1,32})/gm, (all, head, id) => {
    if (!taken.has(id)) { taken.add(id); return all; }
    let fresh = randomId();
    while (taken.has(fresh)) fresh = randomId();
    taken.add(fresh);
    return head + fresh;
  });
}

export const pasteTables = EditorView.domEventHandlers({
  paste(e, view) {
    const data = e.clipboardData;
    if (!data) return false;
    const sel = view.state.selection.main;
    const ln = view.state.doc.lineAt(sel.from).number;
    const cells = parseCells(view.state);
    const raw = data.getData('text/plain') || '';
    // A PICTURE and no text: a screenshot, an image copied from a viewer. It
    // becomes the LaTeX of the formula it shows, or a figure of the document
    // (img-latex.js asks which). A spreadsheet also puts a picture of the
    // cells on the clipboard — but with their text, so it never comes here.
    if (!raw.trim()) {
      const item = [...(data.items || [])].find((it) => it.kind === 'file' && /^image\/(png|jpe?g|bmp|webp|gif)/i.test(it.type));
      const file = item && item.getAsFile();
      if (file) {
        e.preventDefault();
        import('./img-latex.js').then((m) => m.pastedImage(view, file)).catch(() => {});
        return true;
      }
    }
    if (cellAtLine(cells, ln)) {
      // Python: as copied, cleaned of what Python rejects.
      const clean = cleanPaste(raw, { python: true });
      if (clean === raw.replace(/\r\n?/g, '\n')) return false;
      e.preventDefault();
      view.dispatch({
        changes: { from: sel.from, to: sel.to, insert: clean },
        selection: { anchor: sel.from + clean.length },
        userEvent: 'input.paste',
        scrollIntoView: true,
      });
      return true;
    }
    const text = freshCellIds(cleanPaste(raw), cells.map((c) => c.id).filter(Boolean));
    let rows = parseTsv(text);
    const html = data.getData('text/html') || '';
    const hrows = html ? parseHtmlTable(html) : null;
    if (rows) {
      // The HTML beside it (if it is the same table) knows the merged cells
      // and which ones are bold.
      if (hrows && hrows.length === rows.length) rows = hrows;
    } else if (hrows && hrows.length >= 2 && isSpreadsheetHtml(html) && !LOOKS_LIKE_CODE.test(text)) {
      // ONE column copied from a spreadsheet: no tab anywhere in the text, so
      // it used to paste as loose lines. Two cells or more are a table; a
      // single cell stays the text it is.
      rows = hrows;
    }
    if (!rows) {
      if (text === raw.replace(/\r\n?/g, '\n')) return false; // nothing to clean: the editor pastes
      e.preventDefault();
      view.dispatch({
        changes: { from: sel.from, to: sel.to, insert: text },
        selection: { anchor: sel.from + text.length },
        userEvent: 'input.paste',
        scrollIntoView: true,
      });
      return true;
    }
    e.preventDefault();
    const rules = tableRules(view.state.doc.toString());
    const indent = (view.state.doc.lineAt(sel.from).text.match(/^[ \t]*/) || [''])[0];
    const plain = text;
    // Step 1: the text as copied (one undo step on its own)…
    view.dispatch({ changes: { from: sel.from, to: sel.to, insert: plain }, userEvent: 'input.paste' });
    // …step 2: the table in its place.
    const float = general.pasteTableFloat === true;
    const table = rowsToTabular(rows, { rules, indent, float });
    // In a table environment the caret waits inside \caption{}: the title is
    // the one thing the spreadsheet could not give.
    const cap = float ? table.indexOf('\\caption{') : -1;
    view.dispatch({
      changes: { from: sel.from, to: sel.from + plain.length, insert: table },
      selection: { anchor: sel.from + (cap >= 0 ? cap + '\\caption{'.length : table.length) },
      userEvent: 'input.paste',
    });
    return true;
  },
});
