// Paste a table from Excel, LibreOffice, Word or a web page as a LaTeX
// tabular — TeXstudio's "Pegar como tabla LaTeX", automatic.
//
// What the spreadsheet puts on the clipboard: tab-separated rows as plain
// text (and HTML alongside). A web page gives only HTML. Either becomes a
// tabular with the columns aligned (numbers to the right, text to the left),
// special characters escaped, and booktabs rules when the document loads
// booktabs (\hline otherwise). The plain paste happens FIRST and the table
// replaces it in a second step, so Ctrl+Z gives back the text as copied.
// Inside a Python cell, the paste is left alone.

import { EditorView } from '@codemirror/view';
import { parseCells, cellAtLine } from './cell-parse.js';

const SPECIAL = { '\\': '\\textbackslash{}', '&': '\\&', '%': '\\%', $: '\\$', '#': '\\#', _: '\\_', '{': '\\{', '}': '\\}', '~': '\\textasciitilde{}', '^': '\\textasciicircum{}' };
export const escapeCell = (s) => String(s).trim().replace(/[\\&%$#_{}~^]/g, (c) => SPECIAL[c]);
const NUMERIC = /^[-+−]?(\d{1,3}([.,  ]\d{3})*|\d+)([.,]\d+)?([eE][-+]?\d+)?\s*%?$/;

/** Rows of cells from tab-separated text, or null if it is not a table. */
export function parseTsv(text) {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
  if (lines.length < 1 || !lines.some((l) => l.includes('\t'))) return null;
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

/** Rows of cells from an HTML table (web page, Word), or null. */
export function parseHtmlTable(html) {
  if (!/<table/i.test(html)) return null;
  let doc;
  try { doc = new DOMParser().parseFromString(html, 'text/html'); } catch (_) { return null; }
  const table = doc.querySelector('table');
  if (!table) return null;
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

export const pasteTables = EditorView.domEventHandlers({
  paste(e, view) {
    const data = e.clipboardData;
    if (!data) return false;
    const sel = view.state.selection.main;
    const ln = view.state.doc.lineAt(sel.from).number;
    if (cellAtLine(parseCells(view.state), ln)) return false; // Python: leave it
    const text = data.getData('text/plain') || '';
    let rows = parseTsv(text);
    if (!rows) {
      const html = data.getData('text/html') || '';
      rows = html ? parseHtmlTable(html) : null;
      if (rows && rows.length < 2 && rows[0].length < 2) rows = null;
    }
    if (!rows) return false;
    e.preventDefault();
    const doc = view.state.doc.toString();
    const booktabs = /\\usepackage\s*(?:\[[^\]]*\])?\s*\{[^}]*\bbooktabs\b[^}]*\}/.test(doc);
    const indent = (view.state.doc.lineAt(sel.from).text.match(/^[ \t]*/) || [''])[0];
    const plain = text || rows.map((r) => r.map((c) => (typeof c === 'string' ? c : c.text)).join('\t')).join('\n');
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
