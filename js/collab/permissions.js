// What a collaborator may change: Python, LaTeX, both, or nothing.
//
// The host decides per person. The rule is checked TWICE:
//   - on the guest, as a courtesy (an edit it may not make is refused at the
//     keyboard, with a message, instead of vanishing a moment later);
//   - on the host, which is the one that counts: every change a guest sends
//     is classified there against the exact text before and after, and a
//     change outside that guest's rights is undone before anyone else sees
//     it. A modified client cannot get around it.
//
// "Python" is exactly what Pyx would EXECUTE: the cells (`%#python … %#end`,
// header included), every `\py{…}`, every `\pyif` condition and every
// `\pyfile{…}` / `\pynotebook{…}` link — found with the same parsers the
// compiler uses, so the two can never disagree. A change is a Python change
// when that executable projection of the document differs before and after;
// it is a LaTeX change when the rest of the text differs. Comparing the
// projections — not positions — is what closes the tricky cases: joining two
// lines so a `%#python` written in a comment starts a line (a new cell),
// deleting a `%#end`, wrapping a cell in a verbatim environment, typing the
// backslash that turns `\\py{x}` into `\py{x}`.

import { parseCellsText } from '../editor/cell-parse.js';
import { findPyExprs, findPyIfExprs, collectPyIfConds } from '../compile/latex-bridge.js';
import { LINK_CMD_SRC } from '../editor/notebooks.js';

export const PERM_NONE = Object.freeze({ python: false, latex: false });
export const PERM_ALL = Object.freeze({ python: true, latex: true });

export function normPerms(p) {
  return { python: !!(p && p.python), latex: !!(p && p.latex) };
}

export function permLabel(p) {
  const q = normPerms(p);
  if (q.python && q.latex) return 'Python y LaTeX';
  if (q.python) return 'Solo Python';
  if (q.latex) return 'Solo LaTeX';
  return 'Solo lectura';
}

/** How a file is treated: 'python' (all of it executes) or 'mixed' (its
 *  cells, `\py{}`, `\pyif` conditions and links execute; the rest is LaTeX).
 *
 *  There is NO "pure LaTeX" kind, on purpose. A `.tex` was once treated as
 *  one ("Pyx never runs cells in a .tex"), but the compiler does run them:
 *  any file of the project that carries `%#python` cells — a `.tex`, and
 *  just as well a `.sty` or a `.txt` pulled in with `\input` — is processed
 *  like a `.pltx`. With that kind, someone allowed to change only LaTeX
 *  could type a cell into a `.tex` and the host's machine executed it. Every
 *  text file is therefore checked by what would execute in it. */
export function fileKind(name) {
  const n = String(name || '').toLowerCase();
  if (/\.(py|ipynb)$/.test(n)) return 'python';
  return 'mixed';
}

const LINK_RE = new RegExp(LINK_CMD_SRC, 'g');

/** Offsets [from, to) of every executable region of a mixed document. */
export function pythonRegions(text) {
  const out = [];
  // Cells: whole lines, header and %#end included, with their newline, so a
  // cell inserted or removed at a line start leaves the LaTeX projection as
  // it was (that is a Python change, and only one).
  const cells = parseCellsText(text);
  if (cells.length) {
    const starts = [0];
    for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
    const lineEnd = (ln) => (ln < starts.length ? starts[ln] : text.length); // after the newline
    for (const c of cells) out.push([starts[c.headerLine - 1], lineEnd(c.endLine)]);
  }
  for (const e of findPyExprs(text)) out.push([e.start, e.end]);
  // Only the CONDITION of a \pyif is Python; its branches are LaTeX (and any
  // \py{} inside them is found above).
  for (const e of findPyIfExprs(text)) out.push([e.start, e.thenAt - 1]);
  LINK_RE.lastIndex = 0;
  for (let m = LINK_RE.exec(text); m; m = LINK_RE.exec(text)) out.push([m.index, m.index + m[0].length]);
  out.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  // Merge overlaps (a \py{} inside a cell is part of the cell).
  const merged = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && r[0] < last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

/** Everything that would execute, in order, as one comparable string. */
export function pythonProjection(text) {
  const cells = parseCellsText(text);
  const lines = cells.length ? text.split('\n') : [];
  const parts = cells.map((c) => `C${lines[c.headerLine - 1].trim()}\n${c.code}`);
  for (const e of findPyExprs(text)) parts.push(`E${e.expr}`);
  for (const c of collectPyIfConds(text)) parts.push(`I${c}`);
  LINK_RE.lastIndex = 0;
  for (let m = LINK_RE.exec(text); m; m = LINK_RE.exec(text)) parts.push(`L${m[0]}`);
  return parts.join('\u0000');
}

/** The document with every executable region taken out. */
export function latexProjection(text) {
  const regions = pythonRegions(text);
  if (!regions.length) return text;
  let out = '';
  let at = 0;
  for (const [a, b] of regions) { out += text.slice(at, a); at = b; }
  return out + text.slice(at);
}

/** What kinds of content a change from `before` to `after` touches. */
export function classifyChange(before, after, fileName) {
  if (before === after) return { python: false, latex: false };
  const kind = fileKind(fileName);
  if (kind === 'python') return { python: true, latex: false };
  return {
    python: pythonProjection(before) !== pythonProjection(after),
    latex: latexProjection(before) !== latexProjection(after),
  };
}

/** May someone with `perms` change `before` into `after`? */
export function allowedChange(before, after, fileName, perms) {
  const p = normPerms(perms);
  if (p.python && p.latex) return { ok: true };
  const c = classifyChange(before, after, fileName);
  if (c.python && !p.python) return { ok: false, why: 'python' };
  if (c.latex && !p.latex) return { ok: false, why: 'latex' };
  return { ok: true };
}

export function deniedMessage(why) {
  return why === 'python'
    ? 'No tienes permiso para modificar el código Python de este documento (celdas, \\py{}, \\pyif, \\pyfile).'
    : why === 'latex'
      ? 'Solo tienes permiso para modificar el código Python de este documento.'
      : 'En esta sesión solo puedes leer.';
}

/* ---------- the fast path (host, large documents) ----------
 *
 * The exact check above reads the whole text twice: ~90 ms on a 3 MB
 * document, for every burst a collaborator types — the host's window would
 * stutter. Almost every keystroke is plain prose or plain code, though, and
 * for those the answer can be proven from the edit alone, using the
 * editor's own immutable texts (`Text`, whose cell parse Pyx has memoized
 * for that very version anyway):
 *
 *   LaTeX-only guest, edit proven NOT to touch Python when
 *     - what was inserted and deleted holds none of  % # \ { } and no line
 *       break (nothing that could open, close, comment out or protect code);
 *     - the lines it touches, before and after, mention neither \py…, %#
 *       nor \verb;
 *     - no \py…{ group (even one spanning several lines) encloses it;
 *     - the cells are the same cells with the same code.
 *   Python-only guest, edit proven NOT to touch LaTeX when it falls inside
 *     the code lines of a cell and leaves the cell structure as it was.
 *
 * Anything else returns null and the exact check decides. So this can only
 * say "allowed" sooner, never let through what the exact check refuses. */

const RISKY = /[%#\\{}\r\n]/;

function cellsSig(cells, text) {
  return cells.map((c) => `${text.line(c.headerLine).text.trim()}\u0000${c.codeHash}`).join('\u0001');
}

/** Delta (Yjs) → [{ from, to, ins }] in the coordinates of the old text. */
function deltaEdits(delta) {
  const out = [];
  let pos = 0;
  for (const op of delta) {
    if (op.retain != null) pos += op.retain;
    else if (op.insert != null) out.push({ from: pos, to: pos, ins: typeof op.insert === 'string' ? op.insert : '\u0000' });
    else if (op.delete != null) { out.push({ from: pos, to: pos + op.delete, ins: '' }); pos += op.delete; }
  }
  return out;
}

/** Is offset `p` inside a \py…{…} group starting within `reach` chars before it? */
function insidePyGroup(text, p, reach = 20000) {
  const start = Math.max(0, p - reach);
  const back = text.sliceString(start, p);
  let at = back.lastIndexOf('\\py');
  let seen = 0;
  while (at >= 0) {
    if (++seen > 64) return true; // too many to be sure: be conservative
    const tail = text.sliceString(start + at, Math.min(text.length, p + 1));
    const open = tail.indexOf('{');
    if (open < 0) return true;
    let depth = 0;
    let closed = false;
    for (let i = open; i < tail.length; i++) {
      const ch = tail[i];
      if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) { closed = start + at + i < p; break; }
    }
    if (!closed) return true;
    at = at > 0 ? back.lastIndexOf('\\py', at - 1) : -1;
  }
  return false;
}

function linesOf(text, from, to) {
  return text.sliceString(text.lineAt(from).from, text.lineAt(Math.min(to, text.length)).to);
}

/**
 * true when the change from `before` to `after` (CodeMirror Texts, `delta`
 * the Yjs delta between them) is proven allowed for `perms`; null when only
 * the exact check can tell. `cellsOf(text)` → the cells of that text.
 */
export function quickVerdict(before, after, delta, fileName, perms, cellsOf) {
  const p = normPerms(perms);
  if (p.python && p.latex) return true;
  if (!p.python && !p.latex) return null;
  const kind = fileKind(fileName);
  if (kind === 'python') return p.python ? true : null;
  const edits = deltaEdits(delta);
  if (!edits.length) return true;
  const cb = cellsOf(before), ca = cellsOf(after);
  if (p.latex) {
    for (const e of edits) {
      if (RISKY.test(e.ins) || (e.to > e.from && RISKY.test(before.sliceString(e.from, e.to)))) return null;
    }
    if (cb.length !== ca.length || cellsSig(cb, before) !== cellsSig(ca, after)) return null;
    let shift = 0;
    for (const e of edits) {
      const a0 = e.from + shift;
      const a1 = a0 + e.ins.length;
      const lb = linesOf(before, e.from, e.to), la = linesOf(after, a0, a1);
      if (/\\py|%#|\\verb/.test(lb) || /\\py|%#|\\verb/.test(la)) return null;
      if (insidePyGroup(before, e.from) || insidePyGroup(after, a0)) return null;
      shift += e.ins.length - (e.to - e.from);
    }
    return true;
  }
  // Python only: every edit inside the code lines of one cell, same cells.
  if (cb.length !== ca.length) return null;
  for (let i = 0; i < cb.length; i++) {
    if (before.line(cb[i].headerLine).text !== after.line(ca[i].headerLine).text) return null;
  }
  const inCode = (cells, text, a, b) => cells.some((c) => c.endLine - c.headerLine >= 2
    && a >= text.line(c.headerLine + 1).from && b <= text.line(c.endLine - 1).to);
  let shift = 0;
  for (const e of edits) {
    const a0 = e.from + shift;
    if (!inCode(cb, before, e.from, e.to) || !inCode(ca, after, a0, a0 + e.ins.length)) return null;
    shift += e.ins.length - (e.to - e.from);
  }
  return true;
}
