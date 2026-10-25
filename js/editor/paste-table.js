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

/** Rows of cells from an HTML table (web page, Word), or null. A table that
 *  lays out CODE (line numbers beside the lines: GitHub, Pygments, highlight.js)
 *  is not one. */
export function parseHtmlTable(html) {
  if (!/<table/i.test(html)) return null;
  let doc;
  try { doc = new DOMParser().parseFromString(html, 'text/html'); } catch (_) { return null; }
  const table = doc.querySelector('table');
  if (!table) return null;
  if (table.querySelector('pre, code, .blob-code, .highlight, .hljs, .linenos, .lineno, [data-line-number]')
    || /\b(highlight|blob|code|linenos|diff)\b/i.test(`${table.className} ${table.id}`)) return null;
  const rows = [];
  for (const tr of table.querySelectorAll('tr')) {
    const row = [];
    for (const td of tr.querySelectorAll('th, td')) {
      const span = Math.max(1, Math.min(50, +td.getAttribute('colspan') || 1));
      row.push({ text: td.textContent.replace(/\s+/g, ' ').trim(), span });
    }
    if (row.length) rows.push(row);
  }
  if (!rows.length) return null;
  return rows;
}

/** The tabular for rows of strings (or {text, span} for merged cells). */
export function rowsToTabular(rows, { booktabs = false, indent = '' } = {}) {
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
  const line = (r) => r.map((c) => (c.span > 1 ? `\\multicolumn{${c.span}}{c}{${escapeCell(c.text)}}` : escapeCell(c.text))).join(' & ') + ' \\\\';
  const top = booktabs ? '\\toprule' : '\\hline';
  const mid = booktabs ? '\\midrule' : '\\hline';
  const bot = booktabs ? '\\bottomrule' : '\\hline';
  const body = [top, line(cells[0])];
  if (cells.length > 1) body.push(mid, ...cells.slice(1).map(line));
  body.push(bot);
  return `\\begin{tabular}{${align.join('')}}\n${body.map((l) => `${indent}  ${l}`).join('\n')}\n${indent}\\end{tabular}`;
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
    if (rows) {
      // The HTML beside it (if it is the same table) knows the merged cells.
      const html = data.getData('text/html') || '';
      const hrows = html ? parseHtmlTable(html) : null;
      if (hrows && hrows.length === rows.length) rows = hrows;
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
    const doc = view.state.doc.toString();
    const booktabs = /\\usepackage\s*(?:\[[^\]]*\])?\s*\{[^}]*\bbooktabs\b[^}]*\}/.test(doc);
    const indent = (view.state.doc.lineAt(sel.from).text.match(/^[ \t]*/) || [''])[0];
    const plain = text;
    // Step 1: the text as copied (one undo step on its own)…
    view.dispatch({ changes: { from: sel.from, to: sel.to, insert: plain }, userEvent: 'input.paste' });
    // …step 2: the table in its place.
    const table = rowsToTabular(rows, { booktabs, indent });
    view.dispatch({
      changes: { from: sel.from, to: sel.from + plain.length, insert: table },
      selection: { anchor: sel.from + table.length },
      userEvent: 'input.paste',
    });
    return true;
  },
});
