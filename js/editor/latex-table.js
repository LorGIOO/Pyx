// TeXstudio-style table manipulation for the cursor's tabular/array: add or
// delete rows and columns (keeping the column spec in sync), toggle \hline.
// Operates on the innermost tabular-like environment around the caret.

const TABLE_ENVS = ['tabular', 'tabularx', 'array', 'longtable', 'supertabular', 'matrix',
  'pmatrix', 'bmatrix', 'vmatrix', 'Bmatrix', 'Vmatrix'];

// Split a row into cells on unescaped & (so \& stays inside a cell).
function splitCells(row) {
  return row.split(/(?<!\\)&/);
}
// Split a body into rows on \\ (with optional [len]); keep no empty tail logic here.
function splitRows(body) {
  return body.split(/\\\\(?:\s*\[[^\]]*\])?/);
}

// Locate the innermost table environment containing `pos`. Returns null or
// { envFrom, envTo, name, specFrom, specTo, bodyFrom, bodyTo }.
function findTable(text, pos) {
  const begin = /\\begin\{(tabular\*?|tabularx|array|longtable|supertabular|[pbvB]?matrix|Vmatrix)\}/g;
  let m, best = null;
  while ((m = begin.exec(text))) {
    const name = m[1].replace('*', '');
    if (!TABLE_ENVS.includes(name)) continue;
    // Match the corresponding \end (nesting-aware for the same name).
    const endRe = new RegExp(`\\\\(begin|end)\\{${name}\\*?\\}`, 'g');
    endRe.lastIndex = m.index;
    let depth = 0, endIdx = -1, em;
    while ((em = endRe.exec(text))) {
      if (em[1] === 'begin') depth++;
      else if (--depth === 0) { endIdx = em.index; break; }
    }
    if (endIdx < 0) continue;
    if (pos < m.index || pos > endIdx) continue;
    // Parse args after \begin{name}: optional [pos], tabularx width {..},
    // then the column spec {..}.
    let i = m.index + m[0].length;
    const skipWs = () => { while (i < text.length && /\s/.test(text[i])) i++; };
    const skipBracket = () => { skipWs(); if (text[i] === '[') { const c = text.indexOf(']', i); i = c < 0 ? i : c + 1; } };
    const readBrace = () => {
      skipWs();
      if (text[i] !== '{') return null;
      let d = 0, s = i;
      for (; i < text.length; i++) { if (text[i] === '{') d++; else if (text[i] === '}' && --d === 0) { i++; break; } }
      return [s + 1, i - 1];
    };
    skipBracket();
    if (name === 'tabularx' || name === 'tabular*') readBrace(); // width arg
    let spec = null;
    if (!name.endsWith('matrix')) spec = readBrace(); // matrices have no spec
    const bodyFrom = i;
    best = {
      envFrom: m.index, envTo: endIdx, name,
      specFrom: spec ? spec[0] : -1, specTo: spec ? spec[1] : -1,
      bodyFrom, bodyTo: endIdx,
    };
  }
  return best;
}

// Walk the column letters of a spec like |l|p{2cm}r|, calling cb(n, i, end)
// per column: n = column index, [i, end) covers the letter AND its {width}
// group for p/m/b columns. cb returning true stops the walk. ONE scanner —
// insert/remove/align all count columns identically (they used to diverge).
function scanSpec(spec, cb) {
  let count = -1;
  for (let i = 0; i < spec.length; i++) {
    const ch = spec[i];
    if (!'lcrpmb'.includes(ch)) continue;
    count++;
    let end = i + 1;
    if ('pmb'.includes(ch) && spec[end] === '{') {
      let d = 0;
      for (let j = end; j < spec.length; j++) {
        if (spec[j] === '{') d++;
        else if (spec[j] === '}' && --d === 0) { end = j + 1; break; }
      }
    }
    if (cb(count, i, end) === true) return;
    i = end - 1;
  }
}

// Which row/col the caret is in, plus the parsed rows of the body.
function locate(table, text, pos) {
  const body = text.slice(table.bodyFrom, table.bodyTo);
  const rel = Math.max(0, pos - table.bodyFrom);
  const rows = splitRows(body);
  let acc = 0, rowIdx = 0;
  for (let r = 0; r < rows.length; r++) {
    const len = rows[r].length + 2; // approx for the \\ delimiter
    if (rel <= acc + len) { rowIdx = r; break; }
    acc += len;
    rowIdx = r;
  }
  const within = rel - acc;
  const cells = splitCells(rows[rowIdx] || '');
  let cacc = 0, colIdx = 0;
  for (let c = 0; c < cells.length; c++) {
    const len = cells[c].length + 1;
    if (within <= cacc + len) { colIdx = c; break; }
    cacc += len; colIdx = c;
  }
  return { body, rows, rowIdx, colIdx };
}

// Is this row segment a real data row (has cells) vs just \hline/whitespace?
function isDataRow(seg) {
  return splitCells(seg).some((c) => c.replace(/\\hline|\\toprule|\\midrule|\\bottomrule|\s/g, '') !== '');
}

function rebuild(view, table, newBody, newSpec) {
  const changes = [{ from: table.bodyFrom, to: table.bodyTo, insert: newBody }];
  if (newSpec != null && table.specFrom >= 0) {
    changes.push({ from: table.specFrom, to: table.specTo, insert: newSpec });
  }
  view.dispatch({ changes });
  view.focus();
}

function withTable(view, fn) {
  const text = view.state.doc.toString();
  const pos = view.state.selection.main.head;
  const table = findTable(text, pos);
  if (!table) return false;
  fn(view, table, text, pos);
  return true;
}

/* ---------------- operations ---------------- */
export function tableAddRow(view, above = false) {
  return withTable(view, (v, table, text, pos) => {
    const { rows, rowIdx } = locate(table, text, pos);
    const cols = Math.max(1, splitCells(rows[rowIdx] || '').length);
    const empty = ' ' + Array(cols).fill('').join(' & ') + ' ';
    // Insert "<empty> \\\n" after (or before) the current row's \\.
    const rowsOut = rows.slice();
    const insAt = above ? rowIdx : rowIdx + 1;
    rowsOut.splice(insAt, 0, '\n' + empty);
    rebuild(v, table, rowsOut.join('\\\\'));
  });
}

export function tableAddColumn(view) {
  return withTable(view, (v, table, text, pos) => {
    const { rows, colIdx } = locate(table, text, pos);
    const out = rows.map((seg) => {
      if (!isDataRow(seg)) return seg;
      const cells = splitCells(seg);
      cells.splice(Math.min(colIdx + 1, cells.length), 0, '  ');
      return cells.join('&');
    });
    let spec = null;
    if (table.specFrom >= 0) {
      const s = text.slice(table.specFrom, table.specTo);
      spec = insertSpecColumn(s, colIdx);
    }
    rebuild(v, table, out.join('\\\\'), spec);
  });
}

export function tableDeleteRow(view) {
  return withTable(view, (v, table, text, pos) => {
    const { rows, rowIdx } = locate(table, text, pos);
    if (!isDataRow(rows[rowIdx])) return;
    const out = rows.slice();
    out.splice(rowIdx, 1);
    rebuild(v, table, out.join('\\\\'));
  });
}

export function tableDeleteColumn(view) {
  return withTable(view, (v, table, text, pos) => {
    const { rows, colIdx } = locate(table, text, pos);
    const out = rows.map((seg) => {
      if (!isDataRow(seg)) return seg;
      const cells = splitCells(seg);
      if (cells.length <= 1) return seg;
      cells.splice(Math.min(colIdx, cells.length - 1), 1);
      return cells.join('&');
    });
    let spec = null;
    if (table.specFrom >= 0) spec = removeSpecColumn(text.slice(table.specFrom, table.specTo), colIdx);
    rebuild(v, table, out.join('\\\\'), spec);
  });
}

// Insert/remove a \hline at the start of the current row.
export function tableToggleHline(view) {
  return withTable(view, (v, table, text, pos) => {
    const { rows, rowIdx } = locate(table, text, pos);
    const out = rows.slice();
    if (/\\hline/.test(out[rowIdx])) out[rowIdx] = out[rowIdx].replace(/\s*\\hline/, '');
    else out[rowIdx] = out[rowIdx].replace(/^(\s*)/, '$1\\hline\n');
    rebuild(v, table, out.join('\\\\'));
  });
}

// Set the alignment (l/c/r) of the column under the caret — TeXstudio's
// "align column" tool. Edits ONLY the column spec, leaving the cells intact.
// A p/m/b{width} column becomes a plain l/c/r (its {width} is dropped).
export function tableSetColumnAlign(view, align) {
  return withTable(view, (v, table, text, pos) => {
    if (table.specFrom < 0) return; // matrices have no column spec
    const { colIdx } = locate(table, text, pos);
    const spec = setSpecColumnAlign(text.slice(table.specFrom, table.specTo), colIdx, align);
    v.dispatch({ changes: [{ from: table.specFrom, to: table.specTo, insert: spec }] });
    v.focus();
  });
}
function setSpecColumnAlign(spec, col, align) {
  let out = null;
  scanSpec(spec, (n, i, end) => {
    if (n === col) { out = spec.slice(0, i) + align + spec.slice(end); return true; }
  });
  return out ?? spec;
}

// --- column-spec editing (insert/remove the n-th column, width group included) ---
function insertSpecColumn(spec, afterCol) {
  let out = null;
  scanSpec(spec, (n, i, end) => {
    if (n === afterCol) { out = spec.slice(0, end) + 'c' + spec.slice(end); return true; }
  });
  return out ?? spec + 'c';
}
function removeSpecColumn(spec, col) {
  let out = null;
  scanSpec(spec, (n, i, end) => {
    if (n === col) { out = spec.slice(0, i) + spec.slice(end); return true; }
  });
  return out ?? spec;
}

// Insert a fresh table at the cursor (when none surrounds it).
export function insertTable(view, rows = 2, cols = 2) {
  const spec = '|' + Array(cols).fill('c').join('|') + '|';
  const line = Array(cols).fill(' ').join(' & ');
  const bodyRows = Array(rows).fill(`  ${line} \\\\`).join('\n  \\hline\n');
  const tex = `\\begin{tabular}{${spec}}\n  \\hline\n${bodyRows}\n  \\hline\n\\end{tabular}`;
  const sel = view.state.selection.main;
  view.dispatch({ changes: { from: sel.from, to: sel.to, insert: tex }, selection: { anchor: sel.from + tex.length } });
  view.focus();
}
