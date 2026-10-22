// Live Python syntax checking for the cells (VSCode-style red squiggles): each
// cell's code is compile()d by the kernel WITHOUT running it, and any
// SyntaxError is underlined at its EXACT document line/column with the message
// shown on hover — errors always carry their location, never a bare message.
//
// Only cells whose code the kernel has not checked yet are sent. Every typing
// pause used to compile EVERY cell of the document: in a long notebook that
// kept the kernel busy for tens of milliseconds each time — and a Mayús+Intro
// pressed right after typing waited behind it. A cell's syntax depends only
// on its code (and on the Python version, part of the key).

import { linter } from '@codemirror/lint';
import { parseCells } from './cells.js';
import { state as appState } from '../core/state.js';
import { kernelExec, isTauri } from '../core/platform.js';

let lintId = 900000; // own id space, distinct from cell runs (cosmetic)

const lintCache = new Map(); // python version + code -> [{line, col, msg}]
const LINT_CACHE_MAX = 4000;
const keyOf = (code) => `${(appState.env && appState.env.python) || ''}\u0000${code}`;

export const pyLint = linter(async (view) => {
  // Only when the kernel is ALREADY alive (linting must never auto-start it)
  // and no compile is in flight (its cell sequence owns the kernel).
  if (!isTauri() || appState.kernelStatus !== 'ready' || appState.compiling) return [];
  const cells = parseCells(view.state);
  if (!cells.length) return [];
  const todo = [...new Set(cells.map((c) => c.code).filter((code) => !lintCache.has(keyOf(code))))];
  if (todo.length) {
    let res;
    try {
      res = await kernelExec({ id: lintId++, lint: todo });
    } catch (_) {
      return [];
    }
    const found = new Map(todo.map((code) => [code, []]));
    for (const f of (res && res.lint) || []) {
      const code = todo[f.cell];
      if (code !== undefined) found.get(code).push({ line: f.line, col: f.col, msg: f.msg });
    }
    for (const [code, errs] of found) {
      if (lintCache.size >= LINT_CACHE_MAX) lintCache.delete(lintCache.keys().next().value);
      lintCache.set(keyOf(code), errs);
    }
  }
  const doc = view.state.doc;
  const diags = [];
  for (const cell of cells) {
    for (const f of lintCache.get(keyOf(cell.code)) || []) {
      const ln = cell.headerLine + Math.max(1, f.line || 1);
      if (ln >= cell.endLine || ln > doc.lines) continue; // stay inside the cell
      const line = doc.line(ln);
      const col = Math.max(0, Math.min((f.col || 1) - 1, line.length));
      const from = line.from + col;
      diags.push({
        from,
        to: Math.max(from, line.to),
        severity: 'error',
        message: `SyntaxError: ${f.msg} (línea ${ln})`,
      });
    }
  }
  return diags;
}, { delay: 600 });
