// Indentation guides — faint vertical lines at each indent level, TeXstudio /
// VSCode-style, so the block hierarchy (and where each block closes) is visible.
//
// Self-contained: no extra dependency. A ViewPlugin adds a background of thin
// vertical gradients to each line, one per indent level. Blank lines inherit
// the guides of the block they sit inside, so a guide runs unbroken down a
// \begin…\end block, its closing line included.

import { RangeSetBuilder } from '@codemirror/state';
import { Decoration, ViewPlugin } from '@codemirror/view';
import { getIndentUnit } from '@codemirror/language';

// Visual columns (0-based) where a guide should sit for `text`'s indentation.
// Each TAB is one level (spanning to the next tab stop); each run of `unit`
// spaces is one level. Returns null for a blank / whitespace-only line.
function guideColumns(text, unit, tabSize) {
  const cols = [];
  let vis = 0;   // visual column reached so far
  let spaces = 0;
  let i = 0;
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === '\t') {
      cols.push(vis);
      vis += tabSize - (vis % tabSize);
      spaces = 0;
    } else if (c === ' ') {
      spaces++;
      vis++;
      if (spaces === unit) { cols.push(vis - unit); spaces = 0; }
    } else {
      break;
    }
  }
  if (i === text.length) return null; // nothing but whitespace → blank line
  return cols;
}

// Blank lines take the guides of their enclosing block: the shared (shorter)
// prefix of the nearest non-blank line above and below. Scans are bounded so a
// huge blank run can never make this O(document).
const SCAN_CAP = 500;
function blankColumns(doc, lineNo, unit, tabSize) {
  let prev = null;
  for (let n = lineNo - 1, k = 0; n >= 1 && k < SCAN_CAP; n--, k++) {
    const g = guideColumns(doc.line(n).text, unit, tabSize);
    if (g) { prev = g; break; }
  }
  let next = null;
  const last = doc.lines;
  for (let n = lineNo + 1, k = 0; n <= last && k < SCAN_CAP; n++, k++) {
    const g = guideColumns(doc.line(n).text, unit, tabSize);
    if (g) { next = g; break; }
  }
  const count = Math.min(prev ? prev.length : 0, next ? next.length : 0);
  if (count === 0) return null;
  return (prev || next).slice(0, count);
}

function styleFor(cols) {
  const imgs = cols
    .map(() => 'linear-gradient(var(--pyx-indent-guide),var(--pyx-indent-guide))')
    .join(',');
  const poss = cols.map((c) => `${c}ch 0`).join(',');
  // content-box: .cm-line has horizontal padding — the guides must be measured
  // from where the TEXT starts, or every line sits 8px left of its column.
  return `background-image:${imgs};background-position:${poss};` +
    'background-size:1px 100%;background-repeat:no-repeat;background-origin:content-box;';
}

function buildGuides(view) {
  const unit = Math.max(1, getIndentUnit(view.state));
  const tabSize = view.state.tabSize || 4;
  const doc = view.state.doc;
  const builder = new RangeSetBuilder();
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = doc.lineAt(pos);
      let cols = guideColumns(line.text, unit, tabSize);
      if (cols === null) cols = blankColumns(doc, line.number, unit, tabSize);
      if (cols && cols.length) {
        builder.add(line.from, line.from,
          Decoration.line({ attributes: { style: styleFor(cols) } }));
      }
      if (line.to + 1 <= pos) break; // guard against non-advancing loops
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

export const indentGuides = ViewPlugin.fromClass(
  class {
    constructor(view) { this.decorations = buildGuides(view); }
    update(u) {
      if (u.docChanged || u.viewportChanged || u.geometryChanged) {
        this.decorations = buildGuides(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);
