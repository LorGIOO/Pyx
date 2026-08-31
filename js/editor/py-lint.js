// Live Python syntax checking for the cells (VSCode-style red squiggles): each
// cell's code is compile()d by the kernel WITHOUT running it, and any
// SyntaxError is underlined at its EXACT document line/column with the message
// shown on hover — errors always carry their location, never a bare message.

import { linter } from '@codemirror/lint';
import { parseCells } from './cells.js';
import { state as appState } from '../core/state.js';
import { kernelExec, isTauri } from '../core/platform.js';

let lintId = 900000; // own id space, distinct from cell runs (cosmetic)

export const pyLint = linter(async (view) => {
  // Only when the kernel is ALREADY alive (linting must never auto-start it)
  // and no compile is in flight (its cell sequence owns the kernel).
  if (!isTauri() || appState.kernelStatus !== 'ready' || appState.compiling) return [];
  const cells = parseCells(view.state);
  if (!cells.length) return [];
  let res;
  try {
    res = await kernelExec({ id: lintId++, lint: cells.map((c) => c.code) });
  } catch (_) {
    return [];
  }
  const doc = view.state.doc;
  const diags = [];
  for (const f of (res && res.lint) || []) {
    const cell = cells[f.cell];
    if (!cell) continue;
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
  return diags;
}, { delay: 600 });
